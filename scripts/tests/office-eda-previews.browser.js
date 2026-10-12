// Tests the real Numbers parser, LibreOffice conversion and OASIS WASM worker.
// Run after npm run build; requires CDN access and Playwright Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const archiver = require('archiver');
const port = process.env.PREVIEW_TEST_PORT || 3142;
const root = path.resolve(__dirname, '../..');

async function zip(file, entries) {
    const output = require('node:fs').createWriteStream(file), archive = archiver('zip');
    const done = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
    archive.pipe(output);
    Object.entries(entries).forEach(([name, content]) => archive.append(content, { name, store: name === 'mimetype' }));
    await archive.finalize(); await done;
}
async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'office-eda-preview-'));
    let server, browser;
    try {
        const namespaces = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
        const styles = `<office:document-styles ${namespaces} office:version="1.2"><office:styles/><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin="2cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`;
        for (const format of ['odt', 'odp']) {
            const mime = 'application/vnd.oasis.opendocument.' + (format === 'odt' ? 'text' : 'presentation');
            const body = format === 'odt'
                ? '<office:text><text:p>OpenDocument text fixture</text:p><text:p text:style-name="Break">Second page fixture</text:p></office:text>'
                : '<office:presentation><draw:page draw:name="Slide 1" draw:master-page-name="Standard"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="14cm" svg:height="5cm"><draw:text-box><text:p>OpenDocument slide fixture</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="Slide 2" draw:master-page-name="Standard"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="14cm" svg:height="5cm"><draw:text-box><text:p>Second slide fixture</text:p></draw:text-box></draw:frame></draw:page></office:presentation>';
            await zip(path.join(temp, 'document.' + format), {
                mimetype: mime,
                'content.xml': `<office:document-content ${namespaces} office:version="1.2"><office:automatic-styles><style:style style:name="Break" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style></office:automatic-styles><office:body>${body}</office:body></office:document-content>`,
                'styles.xml': styles,
                'META-INF/manifest.xml': `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
            });
        }
        await zip(path.join(temp, 'mismatched.odt'), { mimetype: 'application/vnd.oasis.opendocument.presentation', 'content.xml': '<xml/>' });
        await zip(path.join(temp, 'mismatched.numbers'), { 'content.xml': '<xml/>' });
        const response = await fetch('https://docs.sheetjs.com/pres.numbers');
        if (!response.ok) throw new Error(`Numbers fixture download: HTTP ${response.status}`);
        await fs.writeFile(path.join(temp, 'workbook.numbers'), new Uint8Array(await response.arrayBuffer()));
        for (const ext of ['oas', 'oasis']) await fs.copyFile(path.join(__dirname, 'fixtures/layout.' + ext), path.join(temp, 'layout.' + ext));
        await fs.writeFile(path.join(temp, 'api.oas'), 'openapi: 3.1.0\ninfo:\n  title: Shared suffix fixture\n');
        server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            server.stdout.on('data', data => { if (String(data).includes('Server listening')) resolve(); });
            server.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
        });
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        async function open(name) {
            await page.goto(`http://localhost:${port}/?browse=${encodeURIComponent(temp)}`, { waitUntil: 'domcontentloaded' });
            await page.getByText(name, { exact: true }).click();
            await page.locator('.bm-viewer').waitFor();
        }
        await open('workbook.numbers');
        await page.getByRole('cell', { name: 'Bill Clinton', exact: true }).waitFor({ timeout: 60000 });
        assert.equal(await page.locator('select[aria-label="Numbers table"] option').count(), 1);
        await page.getByRole('cell', { name: '42', exact: true }).waitFor();
        console.log('PASS Numbers IWA workbook table rendering');
        await open('mismatched.numbers');
        await page.getByText(/Not a supported Numbers 3\+ IWA workbook/).waitFor();
        await open('mismatched.odt');
        await page.getByText(/package mimetype does not match/).waitFor();
        console.log('PASS office package content checks');
        for (const ext of ['oas', 'oasis']) {
            await open('layout.' + ext);
            await page.getByText(/2 cells · 18 shapes/).waitFor({ timeout: 120000 });
            const canvas = page.locator('canvas[aria-label="OASIS layout canvas"]');
            assert.equal(await canvas.count(), 1);
            const painted = await canvas.evaluate(c => {
                const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let count = 0;
                for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== 21 || pixels[i + 1] !== 26 || pixels[i + 2] !== 32) count++;
                return count;
            });
            assert.ok(painted > 100);
            await page.locator('select[aria-label="OASIS cell"]').selectOption('LEAF');
            await page.getByText(/2 cells · 6 shapes/).waitFor();
            assert.equal(await page.locator('.bm-viewer-body input[type=checkbox]').count(), 6);
            await page.locator('.bm-viewer-body input[type=checkbox]').first().uncheck();
        }
        await open('api.oas');
        assert.equal(await page.locator('canvas[aria-label="OASIS layout canvas"]').count(), 0);
        console.log('PASS compressed/uncompressed OASIS, hierarchy, layers, cell selection and suffix routing');
        for (const ext of ['odt', 'odp']) {
            await open('document.' + ext);
            await page.locator('.pdfv-page canvas').first().waitFor({ timeout: 180000 }).catch(async e => {
                throw new Error(ext + ': ' + (await page.locator('.bm-viewer-body').innerText()) + '\n' + e.message);
            });
            await page.waitForFunction(() => document.querySelectorAll('.pdfv-page canvas').length === 2);
            assert.equal(await page.locator('.pdfv-page canvas').count(), 2);
            assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isVisible(), false);
            console.log(`PASS ${ext.toUpperCase()} converted PDF preview (2 pages)`);
        }
        assert.deepEqual(errors, []);
        console.log('PASS no uncaught browser errors');
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
        await fs.rm(temp, { recursive: true, force: true });
    }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
