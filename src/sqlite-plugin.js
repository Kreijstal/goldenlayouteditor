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
        const columns = execRows(db, `PRAGMA table_info(${JSON.stringify(row.name)})`);
        const indexes = execRows(db, `PRAGMA index_list(${JSON.stringify(row.name)})`).map(index => ({
            ...index,
            columns: execRows(db, `PRAGMA index_info(${JSON.stringify(index.name)})`),
        }));
        const foreignKeys = execRows(db, `PRAGMA foreign_key_list(${JSON.stringify(row.name)})`);
        const countRow = execRows(db, `SELECT COUNT(*) AS count FROM ${JSON.stringify(row.name)}`)[0] || { count: 0 };
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
.sqlite-table{display:block;width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;background:#2d333b;border:1px solid #444c56;border-radius:4px;color:#e6edf3;text-align:left;cursor:pointer}
.sqlite-table.active{border-color:#6cb6ff;background:#303b49}
.sqlite-table-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sqlite-table-meta{color:#adbac7;font-size:11px;margin-top:2px}
.sqlite-content{min-width:0;min-height:0;display:grid;grid-template-rows:auto auto 1fr;background:#1f2328}
.sqlite-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.sqlite-card{background:#2d333b;border:1px solid #444c56;border-radius:4px;padding:7px 8px;min-width:0}
.sqlite-card-label{color:#adbac7;font-size:11px;text-transform:uppercase}
.sqlite-card-value{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sqlite-query{display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.sqlite-query textarea{height:54px;resize:vertical;background:#1f2328;color:#e6edf3;border:1px solid #444c56;border-radius:4px;padding:6px;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
.sqlite-output{margin:0;padding:12px;overflow:auto;color:#d1d7e0;background:#1f2328;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.45;tab-size:2}
.sqlite-message,.sqlite-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#adbac7}
.sqlite-error{color:#ffb4ab}
@media (max-width:800px){.sqlite-main{grid-template-columns:1fr}.sqlite-side{display:none}.sqlite-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}}
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
        this.toolbar.appendChild(makeButton('Schema AST', 'Show database schema AST', () => this._renderJson(this.ast)));
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
        this.outputEl = document.createElement('pre');
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
            btn.innerHTML = '<div class="sqlite-table-name"></div><div class="sqlite-table-meta"></div>';
            btn.querySelector('.sqlite-table-name').textContent = table.name;
            btn.querySelector('.sqlite-table-meta').textContent = `${table.rowCount} row(s) | ${table.columns.length} column(s)`;
            btn.addEventListener('click', () => this._selectTable(table.name));
            this.tablesEl.appendChild(btn);
        }
        this.statusEl.textContent = `${this.ast.tables.length} table(s)`;
        if (this.ast.tables[0]) this._selectTable(this.ast.tables[0].name);
        else this._renderJson(this.ast);
    }

    _selectTable(name) {
        this.selectedTable = name;
        for (const btn of this.tablesEl.querySelectorAll('.sqlite-table')) {
            btn.classList.toggle('active', btn.querySelector('.sqlite-table-name').textContent === name);
        }
        const table = this.ast.tables.find(item => item.name === name);
        this.sqlInput.value = `SELECT * FROM ${JSON.stringify(name)} LIMIT 100;`;
        this._renderJson(table);
    }

    _runQuery() {
        if (!this.db) return;
        try {
            const result = this.db.exec(this.sqlInput.value);
            this._renderJson(result.map(item => ({ columns: item.columns, rows: item.values })));
        } catch (err) {
            this._showError(err.message);
        }
    }

    _renderJson(value) {
        this._renderSummary();
        this.outputEl.className = 'sqlite-output';
        this.outputEl.textContent = JSON.stringify(value || null, null, 2);
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
