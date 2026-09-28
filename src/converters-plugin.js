// --- Converters Plugin ---
// Explorer context-menu conversions for binary/structured formats.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('Converters');

const XLSX_URL = 'https://esm.sh/xlsx@0.18.5';
const WABT_URL = 'https://esm.sh/wabt@1.0.37';
const SQLITE_SCRIPT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js';
const SQLITE_WASM_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm';

let _xlsxPromise = null;
let _wabtPromise = null;
let _sqlPromise = null;

function extOf(name) {
    const match = /\.([^.]+)$/.exec(name || '');
    return match ? match[1].toLowerCase() : '';
}

function stripExt(name) {
    return (name || 'file').replace(/\.[^.]*$/, '');
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) {
            if (window.initSqlJs) resolve();
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.dataset.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureXlsxLoaded() {
    if (!_xlsxPromise) {
        _xlsxPromise = import(XLSX_URL).then(mod => {
            const xlsx = mod.default || mod;
            if (!xlsx || typeof xlsx.read !== 'function') throw new Error('xlsx did not export read');
            return xlsx;
        });
    }
    return _xlsxPromise;
}

async function ensureWabtLoaded() {
    if (!_wabtPromise) {
        _wabtPromise = import(WABT_URL).then(async mod => {
            const factory = mod.default || mod;
            const wabt = typeof factory === 'function' ? await factory() : factory;
            if (!wabt || typeof wabt.readWasm !== 'function') throw new Error('WABT did not export readWasm');
            return wabt;
        });
    }
    return _wabtPromise;
}

async function ensureSqlLoaded() {
    if (!_sqlPromise) {
        _sqlPromise = (async () => {
            await loadScript(SQLITE_SCRIPT_URL);
            if (typeof window.initSqlJs !== 'function') throw new Error('sql.js did not load');
            return window.initSqlJs({ locateFile: () => SQLITE_WASM_URL });
        })();
    }
    return _sqlPromise;
}

async function loadProjectFileBuffer(ctx, fileId) {
    const file = ctx.projectFiles[fileId];
    if (!file) throw new Error('File not found');

    if (ctx.currentWorkspacePath) {
        const relPath = ctx.getRelativePath(fileId);
        const url = '/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + relPath);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.arrayBuffer();
    }

    return new TextEncoder().encode(file.content || '').buffer;
}

function uniqueOutputName(ctx, requestedName) {
    const used = new Set(Object.values(ctx.projectFiles || {}).map(file => file.name));
    if (!used.has(requestedName)) return requestedName;
    const base = requestedName.replace(/(\.[^.]+)?$/, '');
    const ext = requestedName.slice(base.length);
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base}-${i}${ext}`;
        if (!used.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}${ext}`;
}

function createConvertedFile(ctx, sourceFile, suffix, content) {
    const name = uniqueOutputName(ctx, `${stripExt(sourceFile.name)}${suffix}`);
    const id = ctx.createFile(name, content);
    ctx.openEditorTab('editor', { fileId: id, filePath: name }, name, 'editor-' + id);
    return id;
}

function execRows(db, sql) {
    const stmt = db.prepare(sql);
    try {
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
    } finally {
        stmt.free();
    }
}

function sqliteSchemaJson(db) {
    const entries = execRows(db, `
        SELECT type, name, tbl_name AS tableName, rootpage, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
    `);
    const tables = entries.filter(row => row.type === 'table').map(row => ({
        ...row,
        columns: execRows(db, `PRAGMA table_info(${JSON.stringify(row.name)})`),
        indexes: execRows(db, `PRAGMA index_list(${JSON.stringify(row.name)})`),
        foreignKeys: execRows(db, `PRAGMA foreign_key_list(${JSON.stringify(row.name)})`),
    }));
    return {
        databaseList: execRows(db, 'PRAGMA database_list'),
        pageSize: execRows(db, 'PRAGMA page_size')[0],
        pageCount: execRows(db, 'PRAGMA page_count')[0],
        entries,
        tables,
        views: entries.filter(row => row.type === 'view'),
        triggers: entries.filter(row => row.type === 'trigger'),
        indexes: entries.filter(row => row.type === 'index'),
    };
}

async function convertSpreadsheetToCsv(fileId) {
    const ctx = ConvertersPlugin._ctx;
    const file = ctx.projectFiles[fileId];
    const XLSX = await ensureXlsxLoaded();
    const workbook = XLSX.read(await loadProjectFileBuffer(ctx, fileId), { type: 'array', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) throw new Error('Workbook has no sheets');
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheetName]);
    createConvertedFile(ctx, file, `.${firstSheetName}.csv`, csv);
}

async function convertSpreadsheetToJson(fileId) {
    const ctx = ConvertersPlugin._ctx;
    const file = ctx.projectFiles[fileId];
    const XLSX = await ensureXlsxLoaded();
    const workbook = XLSX.read(await loadProjectFileBuffer(ctx, fileId), { type: 'array', cellDates: true });
    const out = {};
    for (const name of workbook.SheetNames) {
        out[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null });
    }
    createConvertedFile(ctx, file, '.sheets.json', JSON.stringify(out, null, 2));
}

async function convertWasmToWat(fileId) {
    const ctx = ConvertersPlugin._ctx;
    const file = ctx.projectFiles[fileId];
    const buffer = await loadProjectFileBuffer(ctx, fileId);
    const wabt = await ensureWabtLoaded();
    const module = wabt.readWasm(new Uint8Array(buffer), { readDebugNames: true });
    module.generateNames();
    module.applyNames();
    const wat = module.toText({ foldExprs: false, inlineExport: false });
    module.destroy();
    createConvertedFile(ctx, file, '.wat', wat);
}

async function convertSqliteSchema(fileId) {
    const ctx = ConvertersPlugin._ctx;
    const file = ctx.projectFiles[fileId];
    const SQL = await ensureSqlLoaded();
    const db = new SQL.Database(new Uint8Array(await loadProjectFileBuffer(ctx, fileId)));
    try {
        createConvertedFile(ctx, file, '.schema.json', JSON.stringify(sqliteSchemaJson(db), null, 2));
    } finally {
        db.close();
    }
}

async function runConversion(label, fn, fileId) {
    try {
        await fn(fileId);
    } catch (err) {
        log.error(`${label} failed:`, err);
        alert(`${label} failed: ${err.message}`);
    }
}

const ConvertersPlugin = {
    _ctx: null,
};

registerPlugin({
    id: 'converters',
    name: 'Converters',
    contextMenuItems: [
        {
            label: 'Convert to CSV',
            canHandle: fileName => ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'].includes(extOf(fileName)),
            action: fileId => runConversion('Convert to CSV', convertSpreadsheetToCsv, fileId),
        },
        {
            label: 'Convert to Sheets JSON',
            canHandle: fileName => ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'].includes(extOf(fileName)),
            action: fileId => runConversion('Convert to Sheets JSON', convertSpreadsheetToJson, fileId),
        },
        {
            label: 'Convert SQLite Schema to JSON',
            canHandle: fileName => ['sqlite', 'sqlite3', 'db'].includes(extOf(fileName)),
            action: fileId => runConversion('Convert SQLite Schema to JSON', convertSqliteSchema, fileId),
        },
        {
            label: 'Convert WASM to WAT',
            canHandle: fileName => extOf(fileName) === 'wasm',
            action: fileId => runConversion('Convert WASM to WAT', convertWasmToWat, fileId),
        },
    ],
    init(ctx) {
        ConvertersPlugin._ctx = ctx;
    },
});
