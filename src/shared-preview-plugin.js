const { registerPlugin } = require('./plugins');
const { readViewerFile, element, table } = require('./viewer-file');
const { isVariantText, parseVariants, summarizeJson, parseXml, summarizeXml } = require('./shared-preview-data');
let ctx;
let markdownModules;

function loadMarkdown() {
    if (!markdownModules) {
        markdownModules = Promise.all([import('https://esm.sh/marked@18.1.1'), import('https://esm.sh/dompurify@3.4.17')]);
        markdownModules.catch(() => { markdownModules = null; });
    }
    return markdownModules;
}

function isMarkdownFile(file) {
    return /\.(md|markdown|mdown)$/i.test(file.name) && !file.viewType
        && !(file.content && /\0/.test(file.content));
}
function isVariantFile(file) {
    return /\.vcf$/i.test(file.name) && isVariantText(file.content || (file.head && new TextDecoder().decode(file.head)));
}

// A bounded expandable tree prevents large inputs from creating unlimited DOM.
function dataTree(parent, value, label = '$', depth = 0, budget = { left: 3000 }) {
    if (--budget.left < 0) return;
    if (value === null || typeof value !== 'object') {
        element('pre', `${label}: ${JSON.stringify(value)}`, parent).style.whiteSpace = 'pre-wrap';
        return;
    }
    const entries = Object.entries(value);
    const details = element('details', null, parent);
    details.open = depth < 1;
    element('summary', `${label} · ${Array.isArray(value) ? 'array' : 'object'} (${entries.length})`, details);
    if (depth >= 20) { element('p', 'Depth limit reached; use the source editor for the complete data.', details); return; }
    let filled = false;
    const fill = () => {
        if (filled || !details.open) return;
        filled = true;
        const body = element('div', null, details);
        body.style.paddingLeft = '16px';
        entries.slice(0, 200).forEach(([k, v]) => dataTree(body, v, k, depth + 1, budget));
        if (entries.length > 200 || budget.left <= 0) element('p', 'Preview limit reached; the source editor contains the complete data.', body);
    };
    details.addEventListener('toggle', fill);
    fill();
}

function xmlValue(el, depth = 0, budget = { left: 3000 }) {
    if (--budget.left < 0) return '[XML preview limit reached]';
    if (depth > 20) return '[deeper XML omitted]';
    return {
        element: el.tagName,
        attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])),
        text: [...el.childNodes].filter(n => n.nodeType === 3 || n.nodeType === 4).map(n => n.textContent).join('').trim(),
        children: [...el.children].slice(0, 200).map(c => xmlValue(c, depth + 1, budget)),
        ...(el.children.length > 200 ? { omittedChildren: el.children.length - 200 } : {}),
    };
}

class SharedPreview {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;overflow:auto;background:#fff;color:#222;font:14px system-ui;box-sizing:border-box;padding:12px';
        const bar = element('div', null, this.root);
        const refresh = element('button', 'Refresh preview', bar);
        refresh.onclick = () => this.load();
        this.status = element('span', '', bar);
        this.status.style.marginLeft = '12px';
        this.body = element('div', null, this.root);
        container.on('destroy', () => { this.destroyed = true; this.generation++; });
        this.generation = 0;
        this.load();
    }

    async load() {
        const generation = ++this.generation;
        this.status.textContent = 'Reading…';
        try {
            const file = ctx.projectFiles[this.fileId];
            const bytes = await readViewerFile(ctx, this.fileId);
            const text = new TextDecoder().decode(bytes);
            if (this.destroyed || generation !== this.generation) return;
            this.body.replaceChildren();
            if (/\.(md|markdown|mdown)$/i.test(file.name)) {
                if (file.viewType || /\0/.test(text)) throw new Error('This is binary data, not a Markdown document.');
                const [marked, purifier] = await loadMarkdown();
                if (this.destroyed || generation !== this.generation) return;
                const html = purifier.default.sanitize(marked.marked.parse(text), { USE_PROFILES: { html: true } });
                const frame = element('iframe', null, this.body);
                frame.title = 'Rendered Markdown';
                frame.setAttribute('sandbox', '');
                frame.style.cssText = 'width:100%;height:calc(100vh - 110px);border:0;background:white';
                frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https:; style-src \'unsafe-inline\'"><style>body{font:16px/1.6 system-ui;max-width:900px;margin:20px auto;padding:0 20px;color:#24292f}pre{padding:12px;background:#f6f8fa;overflow:auto}code{font-family:monospace}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}blockquote{border-left:4px solid #ddd;padding-left:16px}</style>' + html;
            } else if (/\.vcf$/i.test(file.name)) {
                const vcf = parseVariants(text);
                element('h3', `${vcf.total} variants · ${vcf.samples.length} samples`, this.body);
                dataTree(this.body, { chromosomes: vcf.chromosomes, filters: vcf.filters, samples: vcf.samples, metadata: vcf.meta }, 'VCF header');
                const filter = element('input', null, this.body);
                filter.placeholder = 'Filter chromosome, ID, allele, INFO or sample';
                filter.style.cssText = 'width:100%;box-sizing:border-box;margin:10px 0;padding:6px';
                const count = element('p', '', this.body), grid = element('div', null, this.body);
                grid.style.overflow = 'auto';
                const render = () => {
                    const q = filter.value.toLowerCase();
                    const rows = vcf.rows.filter(row => row.some(c => c.toLowerCase().includes(q)));
                    count.textContent = `Showing ${Math.min(rows.length, 250)} of ${rows.length} matches in the first ${vcf.rows.length} of ${vcf.total} records.`;
                    grid.replaceChildren();
                    table(grid, vcf.columns, rows.slice(0, 250));
                };
                filter.oninput = render;
                render();
            } else if (/\.json$/i.test(file.name)) {
                const data = JSON.parse(text.replace(/^\uFEFF/, ''));
                const summary = summarizeJson(data, file.name);
                element('h3', summary.schema, this.body);
                dataTree(this.body, summary, 'Summary');
                dataTree(this.body, data, 'Document');
            } else {
                const doc = parseXml(text), summary = summarizeXml(doc);
                element('h3', summary.schema, this.body);
                dataTree(this.body, summary, 'Summary');
                dataTree(this.body, xmlValue(doc.documentElement), 'Document');
            }
            this.status.textContent = 'Read-only preview';
        } catch (err) {
            if (this.destroyed || generation !== this.generation) return;
            this.body.replaceChildren(element('p', err.message));
            this.status.textContent = 'Could not preview';
        }
    }
}

registerPlugin({
    id: 'shared-previews', name: 'Markdown, genomic variants and structured data',
    components: { sharedPreview: SharedPreview },
    init(context) { ctx = context; },
});
module.exports = { isMarkdownFile, isVariantFile };
