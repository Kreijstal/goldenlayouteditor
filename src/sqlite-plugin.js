// --- SQLite Plugin ---
// Lazy-loads sql.js when a SQLite database is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('SQLite');
const SQLITE_SCRIPT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js';
const SQLITE_WASM_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm';
const SQLITE_RE = /\.(sqlite|sqlite3|db)$/i;

let _sqlPromise = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            if (window.initSqlJs) resolve();
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

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

const PAGE_SIZE = 100;

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

function formatCell(value) {
    if (value === null || value === undefined) return { text: 'NULL', cls: 'sqlite-null' };
    if (value instanceof Uint8Array) return { text: `<blob ${value.length} bytes>`, cls: 'sqlite-null' };
    const text = String(value);
    return { text: text.length > 300 ? text.slice(0, 300) + '\u2026' : text, title: text.length > 300 ? text : null, cls: typeof value === 'number' ? 'sqlite-num' : '' };
}

function execRows(db, sql, params) {
    const stmt = db.prepare(sql);
    try {
        if (params) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
    } finally {
        stmt.free();
    }
}

function buildSchemaAst(db) {
    const entries = execRows(db, `
        SELECT type, name, tbl_name AS tableName, rootpage, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
    `);
    const tables = entries.filter(row => row.type === 'table').map(row => {
        const columns = execRows(db, `PRAGMA table_info(${quoteIdent(row.name)})`);
        const indexes = execRows(db, `PRAGMA index_list(${quoteIdent(row.name)})`).map(index => ({
            ...index,
            columns: execRows(db, `PRAGMA index_info(${quoteIdent(index.name)})`),
        }));
        const foreignKeys = execRows(db, `PRAGMA foreign_key_list(${quoteIdent(row.name)})`);
        const countRow = execRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdent(row.name)}`)[0] || { count: 0 };
        return {
            name: row.name,
            sql: row.sql,
            rowCount: countRow.count,
            columns,
            indexes,
            foreignKeys,
        };
    });

    return {
        databaseList: execRows(db, 'PRAGMA database_list'),
        userVersion: execRows(db, 'PRAGMA user_version')[0],
        schemaVersion: execRows(db, 'PRAGMA schema_version')[0],
        pageSize: execRows(db, 'PRAGMA page_size')[0],
        pageCount: execRows(db, 'PRAGMA page_count')[0],
        entries,
        tables,
        views: entries.filter(row => row.type === 'view'),
        triggers: entries.filter(row => row.type === 'trigger'),
        indexes: entries.filter(row => row.type === 'index'),
    };
}

class SqliteComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = SqliteComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'database.sqlite';
        this.db = null;
        this.ast = null;
        this.selectedTable = null;

        this.root = container.element;
        this.root.classList.add('sqlite-plugin-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (SqliteComponent._styleInstalled) return;
        SqliteComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.sqlite-plugin-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.sqlite-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.sqlite-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:auto}
.sqlite-toolbar button,.sqlite-query button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.sqlite-toolbar button:hover,.sqlite-query button:hover{background:#444c56}
.sqlite-title{font-weight:600;min-width:120px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.sqlite-status{margin-left:auto;color:#adbac7;font-size:12px}
.sqlite-main{display:grid;grid-template-columns:300px 1fr;min-height:0}
.sqlite-side{min-height:0;border-right:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto 1fr}
.sqlite-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px;border-bottom:1px solid #444c56}
.sqlite-tables{overflow:auto;padding:6px}
.sqlite-tables{padding:0}
.sqlite-table{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;min-height:36px;padding:4px 10px;background:none;border:none;border-bottom:1px solid #2d333b;color:#e6edf3;text-align:left;cursor:pointer;font:inherit}
.sqlite-table:hover{background:#2d333b}
.sqlite-table.active{background:#303b49;box-shadow:inset 3px 0 #6cb6ff}
.sqlite-table-icon{flex-shrink:0;opacity:.8}
.sqlite-table-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sqlite-table-meta{flex-shrink:0;color:#adbac7;font-size:11px;font-variant-numeric:tabular-nums}
.sqlite-back{display:none}
.sqlite-content{min-width:0;min-height:0;display:grid;grid-template-rows:auto auto 1fr;background:#1f2328}
.sqlite-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.sqlite-card{background:#2d333b;border:1px solid #444c56;border-radius:4px;padding:7px 8px;min-width:0}
.sqlite-card-label{color:#adbac7;font-size:11px;text-transform:uppercase}
.sqlite-card-value{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sqlite-query{display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.sqlite-query textarea{height:54px;resize:vertical;background:#1f2328;color:#e6edf3;border:1px solid #444c56;border-radius:4px;padding:6px;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
.sqlite-output{margin:0;padding:12px;overflow:auto;color:#d1d7e0;background:#1f2328;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.45;tab-size:2}
.sqlite-output.sqlite-grid-wrap{padding:0;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:normal}
.sqlite-pager{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #444c56;background:#22272e;position:sticky;left:0;top:0;z-index:2;flex-wrap:wrap}
.sqlite-pager button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer}
.sqlite-pager button:disabled{opacity:.4}
.sqlite-grid{border-collapse:collapse;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
.sqlite-grid th{position:sticky;top:0;background:#2d333b;color:#adbac7;text-align:left;font-weight:600;z-index:1}
.sqlite-grid th,.sqlite-grid td{border:1px solid #373e47;padding:3px 6px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top}
.sqlite-grid tr:nth-child(even) td{background:#22272e}
.sqlite-grid td.sqlite-null{color:#768390;font-style:italic}
.sqlite-grid td.sqlite-num{text-align:right;color:#96d0ff}
.sqlite-grid-caption{padding:6px 10px;color:#adbac7}
.sqlite-message,.sqlite-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#adbac7}
.sqlite-error{color:#ffb4ab}
@media (max-width:800px){
.sqlite-main{grid-template-columns:1fr}.sqlite-summary{display:none}.sqlite-query textarea{height:38px}
.sqlite-side{border-right:none}
.sqlite-main.list-mode .sqlite-content{display:none}
.sqlite-main:not(.list-mode) .sqlite-side{display:none}
.sqlite-shell:not(.list-mode) .sqlite-back{display:inline-block}
}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'sqlite-shell';
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'sqlite-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.sqlite,.sqlite3,.db';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local SQLite database', () => this.fileInput.click()));
        this.backBtn = makeButton('\u2039 Tables', 'Back to table list', () => this._setListMode(true));
        this.backBtn.classList.add('sqlite-back');
        this.toolbar.appendChild(this.backBtn);
        this.toolbar.appendChild(makeButton('Schema', 'Show database schema AST', () => this._renderJson(this.ast)));
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'sqlite-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'sqlite-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'sqlite-main';
        this.side = document.createElement('div');
        this.side.className = 'sqlite-side';
        this.side.innerHTML = '<h3>Tables</h3><div class="sqlite-tables"></div>';
        this.tablesEl = this.side.querySelector('.sqlite-tables');

        this.content = document.createElement('div');
        this.content.className = 'sqlite-content';
        this.summaryEl = document.createElement('div');
        this.summaryEl.className = 'sqlite-summary';
        this.queryEl = document.createElement('div');
        this.queryEl.className = 'sqlite-query';
        this.sqlInput = document.createElement('textarea');
        this.sqlInput.spellcheck = false;
        this.sqlInput.value = 'SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE "sqlite_%" LIMIT 50;';
        this.queryEl.appendChild(this.sqlInput);
        this.queryEl.appendChild(makeButton('Run', 'Run SQL query', () => this._runQuery()));
        this.outputEl = document.createElement('div');
        this.outputEl.className = 'sqlite-output';
        this.content.appendChild(this.summaryEl);
        this.content.appendChild(this.queryEl);
        this.content.appendChild(this.outputEl);
        this.main.appendChild(this.side);
        this.main.appendChild(this.content);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a SQLite database to inspect its schema and query it.');
    }

    async _init() {
        if (this.fileData) await this._loadProjectFile();
        else this.statusEl.textContent = 'sql.js loads when a SQLite DB is opened';
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed SQLite loading requires the server workspace.');
                return;
            }
            const relPath = this.ctx.getRelativePath(this.fileId);
            const url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + relPath);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._loadBuffer(await resp.arrayBuffer(), this.fileData.name);
        } catch (err) {
            this._showError(err.message);
        }
    }

    async _loadFileObject(file) {
        await this._loadBuffer(await file.arrayBuffer(), file.name);
    }

    async _loadBuffer(buffer, name) {
        this.fileName = name || this.fileName;
        this.titleEl.textContent = this.fileName;
        this.statusEl.textContent = 'Loading sql.js...';
        this._clear();
        try {
            const SQL = await ensureSqlLoaded();
            this.statusEl.textContent = 'Opening database...';
            if (this.db) this.db.close();
            this.db = new SQL.Database(new Uint8Array(buffer));
            this.ast = buildSchemaAst(this.db);
            this._renderSchema();
        } catch (err) {
            log.error('Failed to open SQLite DB:', err);
            this._showError(`Failed to open SQLite DB: ${err.message}`);
        }
    }

    _renderSchema() {
        this.tablesEl.innerHTML = '';
        for (const table of this.ast.tables) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sqlite-table';
            btn.innerHTML = '<span class="sqlite-table-icon">\u25A6</span><span class="sqlite-table-name"></span><span class="sqlite-table-meta"></span>';
            btn.dataset.table = table.name;
            btn.querySelector('.sqlite-table-name').textContent = table.name;
            btn.querySelector('.sqlite-table-meta').textContent = `${table.rowCount.toLocaleString()} rows \u00B7 ${table.columns.length} cols`;
            btn.addEventListener('click', () => { this._selectTable(table.name); this._setListMode(false); });
            this.tablesEl.appendChild(btn);
        }
        this.statusEl.textContent = `${this.ast.tables.length} table(s)`;
        // Start on the table list; wide layouts also show the first table beside it
        this._setListMode(true);
        if (this.ast.tables[0]) this._selectTable(this.ast.tables[0].name);
        else this._renderJson(this.ast);
    }

    _selectTable(name) {
        this.selectedTable = name;
        for (const btn of this.tablesEl.querySelectorAll('.sqlite-table')) {
            btn.classList.toggle('active', btn.dataset.table === name);
        }
        this.page = 0;
        this._showTablePage();
    }

    _setListMode(on) {
        this.main.classList.toggle('list-mode', on);
        this.shell.classList.toggle('list-mode', on);
    }

    _showTablePage() {
        const table = this.ast.tables.find(item => item.name === this.selectedTable);
        if (!table) return;
        const offset = this.page * PAGE_SIZE;
        const sql = `SELECT * FROM ${quoteIdent(table.name)} LIMIT ${PAGE_SIZE} OFFSET ${offset};`;
        this.sqlInput.value = sql;
        let result;
        try {
            result = this.db.exec(sql)[0] || { columns: table.columns.map(c => c.name), values: [] };
        } catch (err) {
            this._showError(err.message);
            return;
        }
        this._renderSummary();
        this.outputEl.className = 'sqlite-output sqlite-grid-wrap';
        this.outputEl.innerHTML = '';
        const pager = document.createElement('div');
        pager.className = 'sqlite-pager';
        const last = offset + result.values.length;
        const info = document.createElement('span');
        info.textContent = table.rowCount ? `${offset + 1}\u2013${last} of ${table.rowCount}` : 'No rows';
        const prev = makeButton('\u2039', 'Previous page', () => { this.page--; this._showTablePage(); });
        prev.disabled = this.page === 0;
        const next = makeButton('\u203A', 'Next page', () => { this.page++; this._showTablePage(); });
        next.disabled = last >= table.rowCount;
        const cols = makeButton('Columns', 'Show table schema', () => this._renderJson(table));
        pager.append(prev, info, next, cols);
        this.outputEl.appendChild(pager);
        this.outputEl.appendChild(this._buildGrid(result.columns, result.values));
        this.outputEl.scrollTop = 0;
    }

    _buildGrid(columns, rows) {
        const tableEl = document.createElement('table');
        tableEl.className = 'sqlite-grid';
        const head = tableEl.createTHead().insertRow();
        for (const col of columns) {
            const th = document.createElement('th');
            th.textContent = col;
            head.appendChild(th);
        }
        const body = tableEl.createTBody();
        for (const row of rows) {
            const tr = body.insertRow();
            for (const value of row) {
                const td = tr.insertCell();
                const cell = formatCell(value);
                td.textContent = cell.text;
                if (cell.cls) td.className = cell.cls;
                if (cell.title) td.title = cell.title;
            }
        }
        return tableEl;
    }

    _runQuery() {
        if (!this.db) return;
        try {
            const results = this.db.exec(this.sqlInput.value);
            this._renderSummary();
            this.outputEl.className = 'sqlite-output sqlite-grid-wrap';
            this.outputEl.innerHTML = '';
            if (!results.length) {
                const done = document.createElement('div');
                done.className = 'sqlite-grid-caption';
                done.textContent = `OK, ${this.db.getRowsModified()} row(s) changed (in memory only)`;
                this.outputEl.appendChild(done);
            }
            for (const item of results) {
                const caption = document.createElement('div');
                caption.className = 'sqlite-grid-caption';
                caption.textContent = `${item.values.length} row(s)`;
                this.outputEl.appendChild(caption);
                this.outputEl.appendChild(this._buildGrid(item.columns, item.values));
            }
        } catch (err) {
            this._showError(err.message);
        }
    }

    _renderJson(value) {
        this._renderSummary();
        this.outputEl.className = 'sqlite-output';
        this.outputEl.innerHTML = '';
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.textContent = JSON.stringify(value || null, null, 2);
        this.outputEl.appendChild(pre);
    }

    _renderSummary() {
        const table = this.selectedTable && this.ast ? this.ast.tables.find(item => item.name === this.selectedTable) : null;
        const cards = [
            ['File', this.fileName],
            ['Tables', this.ast ? String(this.ast.tables.length) : '0'],
            ['Views', this.ast ? String(this.ast.views.length) : '0'],
            ['Selected', table ? table.name : 'Schema'],
        ];
        this.summaryEl.innerHTML = '';
        for (const [label, value] of cards) {
            const card = document.createElement('div');
            card.className = 'sqlite-card';
            card.innerHTML = '<div class="sqlite-card-label"></div><div class="sqlite-card-value"></div>';
            card.querySelector('.sqlite-card-label').textContent = label;
            card.querySelector('.sqlite-card-value').textContent = value;
            this.summaryEl.appendChild(card);
        }
    }

    _showMessage(message) {
        this._clear();
        this.outputEl.className = 'sqlite-message';
        this.outputEl.textContent = message;
    }

    _showError(message) {
        this.outputEl.className = 'sqlite-error';
        this.outputEl.textContent = message;
        this.statusEl.textContent = 'Error';
    }

    _clear() {
        this.tablesEl.innerHTML = '';
        this.summaryEl.innerHTML = '';
        this.outputEl.className = 'sqlite-output';
        this.outputEl.textContent = '';
    }

    _destroy() {
        if (this.db) this.db.close();
        this.db = null;
    }
}

registerPlugin({
    id: 'sqlite',
    name: 'SQLite',
    components: {
        sqliteInspector: SqliteComponent,
    },
    toolbarButtons: [
        { label: 'SQLite', title: 'Open SQLite Inspector' },
    ],
    contextMenuItems: [{
        label: 'Open SQLite Inspector',
        canHandle: (fileName) => SQLITE_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = SqliteComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('sqliteInspector', { fileId }, `${file.name} [sqlite]`, 'sqlite-' + fileId);
        },
    }],
    init(ctx) {
        SqliteComponent._ctx = ctx;
    },
});
