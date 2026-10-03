// git in the in-browser shell (src/wanix-plugin.js): isomorphic-git, from esm.sh,
// working on the shell's own files (the Wanix namespace) through the fs below.
// It speaks to remotes through a CORS proxy, as browsers may not read git hosts'
// answers otherwise: the http.corsProxy setting (the repository's, else the
// shell's own, /etc/git/config: git config --global http.corsProxy <url>),
// else this site's server's /cors-proxy (server.js) when there is one, else
// isomorphic-git's public one. Passwords and tokens for push come from
// /etc/git/credentials, a line https://<user>:<token>@<host> each (git's
// credential store). A subset of git's commands: git help lists them.

const GIT_VERSION = '1.42.6';
const GIT_URL = `https://esm.sh/isomorphic-git@${GIT_VERSION}`;
const HTTP_URL = `https://esm.sh/isomorphic-git@${GIT_VERSION}/http/web`;
const PUBLIC_PROXY = 'https://cors.isomorphic-git.org';
const GLOBAL_GITDIR = '/etc/git'; // its config is /etc/git/config
const CREDENTIALS = 'etc/git/credentials';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let loading = null;
function loadGit() {
    if (!loading) {
        loading = Promise.all([import(GIT_URL), import(HTTP_URL)])
            .then(([git, http]) => ({ git: git.default || git, http: http.default || http }));
        loading.catch(() => { loading = null; });
    }
    return loading;
}

// ---- Node's fs, as isomorphic-git uses it, on the namespace ----
// Wanix's paths have no leading / ('.' is the top); its errors are messages only.
// Changes are made one at a time: folders made side by side (as isomorphic-git
// makes .git's) fail ("resolve: operation not supported")
function fsFor(root) {
    const at = path => {
        const parts = [];
        for (const p of path.split('/')) {
            if (!p || p === '.') continue;
            if (p === '..') parts.pop(); else parts.push(p);
        }
        return parts.join('/') || '.';
    };
    let changes = Promise.resolve();
    const change = (what, path, fn) => {
        const done = changes.then(() => call(what, path, fn));
        changes = done.catch(() => {});
        return done;
    };
    const call = async (what, path, fn) => {
        try {
            return await fn();
        } catch (err) {
            const message = String((err && err.message) || err);
            const e = new Error(`${what} ${path}: ${message}`);
            e.code = /does not exist|not found/i.test(message) ? 'ENOENT'
                : /already exists/i.test(message) ? 'EEXIST'
                : /not empty/i.test(message) ? 'ENOTEMPTY'
                : /not a directory/i.test(message) ? 'ENOTDIR'
                : 'EIO';
            // Wanix says "resolve: operation not supported" for a path whose folder is not there
            if (e.code === 'EIO') {
                const parent = at(path).replace(/\/?[^/]*$/, '') || '.';
                try { await root.stat(parent); } catch (_) { e.code = 'ENOENT'; }
            }
            throw e;
        }
    };
    const stats = s => {
        const type = (s.Mode & 0o170000) === 0o120000 ? 'symlink' : s.IsDir ? 'dir' : 'file';
        const ms = (s.ModTime || 0) * 1000;
        return {
            type, mode: s.Mode, size: s.Size, ino: 0, uid: 1, gid: 1, dev: 1,
            mtimeMs: ms, ctimeMs: ms, mtime: new Date(ms), ctime: new Date(ms),
            isFile: () => type === 'file', isDirectory: () => type === 'dir', isSymbolicLink: () => type === 'symlink',
        };
    };
    const encoding = opts => (typeof opts === 'string' ? opts : opts && opts.encoding);
    return {
        promises: {
            async readFile(path, opts) {
                const bytes = await call('open', path, () => root.readFile(at(path)));
                return encoding(opts) ? decoder.decode(bytes) : bytes;
            },
            async writeFile(path, data) {
                await change('write', path, () => root.writeFile(at(path), typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data)));
            },
            async unlink(path) { await change('remove', path, () => root.remove(at(path))); },
            async rmdir(path) { await change('rmdir', path, () => root.remove(at(path))); },
            async mkdir(path) { await change('mkdir', path, () => root.makeDir(at(path))); },
            async readdir(path) {
                const names = await call('readdir', path, () => root.readDir(at(path)));
                return (names || []).map(n => n.replace(/\/$/, ''));
            },
            async stat(path) { return stats(await call('stat', path, () => root.stat(at(path)))); },
            async lstat(path) { return stats(await call('lstat', path, () => root.lstat(at(path)))); },
            async readlink(path) { return call('readlink', path, () => root.readlink(at(path))); },
            async symlink(target, path) { await change('symlink', path, () => root.symlink(target, at(path))); },
            async chmod(path, mode) { await change('chmod', path, () => root.chmod(at(path), mode)); },
        },
    };
}

// ---- the command ----
class GitError extends Error {
    constructor(message, code = 128) { super(message); this.exitCode = code; }
}

// Options of a command's words: flags (named in `takes` when they take a value) and the rest
function parse(words, takes = []) {
    const opts = {}, rest = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w === '--') { opts['--'] = true; rest.push(...words.slice(i + 1)); break; }
        const long = /^--([^=]+)(?:=(.*))?$/.exec(w);
        if (long) {
            const [, name, value] = long;
            opts[name] = value !== undefined ? value : takes.includes(name) ? words[++i] : true;
        } else if (/^-[^-]/.test(w)) {
            for (let j = 1; j < w.length; j++) {
                const name = w[j];
                if (takes.includes(name)) {
                    const value = w.slice(j + 1) || words[++i];
                    opts[name] = name === 'm' ? [...(opts.m || []), value] : value;
                    break;
                }
                opts[name] = true;
            }
        } else {
            rest.push(w);
        }
    }
    return { opts, rest };
}

// A path given in the shell's folder, as one of the repository's ('' its top)
function inRepo(repo, cwd, path) {
    const parts = [];
    for (const p of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
        if (!p || p === '.') continue;
        if (p === '..') parts.pop(); else parts.push(p);
    }
    const full = parts.join('/');
    const top = repo.replace(/^\/+/, '');
    if (full === top) return '';
    if (!top) return full;
    if (!full.startsWith(top + '/')) throw new GitError(`fatal: ${path}: outside repository at ${repo}`);
    return full.slice(top.length + 1);
}

const HELP = `usage: git <command> [<args>]   (isomorphic-git ${GIT_VERSION}, in the page)

  clone <url> [<dir>] [--depth <n>] [-b <branch>] [--single-branch] [--no-checkout]
  init [<dir>] [-b <branch>]
  status [-s]
  add <path>… | -A | .        rm [--cached] <path>…
  commit -m <message> [-a] [--amend]
  log [-n <n>] [--oneline]
  branch [-a] [-d <name>] [<name>]      checkout [-b] <branch> | [<ref>] -- <path>…
  switch [-c] <branch>        merge <branch>      reset [--hard] [<ref>] | <path>…
  fetch [<remote>] [--depth <n>] [--tags]      pull [<remote>] [<branch>]
  push [<remote>] [<branch>] [-f]
  remote [-v] | add <name> <url> | remove <name>
  tag [-a -m <message>] [<name>] | -d <name>
  config [--global] [--list] [--unset] <key> [<value>]
  rev-parse [--abbrev-ref] <ref>    ls-files    show-ref    version

Remotes go through a CORS proxy: git config --global http.corsProxy <url>.
Push credentials: /etc/git/credentials, https://<user>:<token>@<host> a line.
`;

async function runGit(root, cwd, args, io, ctx) {
    const { git, http } = await loadGit();
    const fs = fsFor(root);
    const out = text => io.out(text);
    const here = '/' + (cwd === '.' ? '' : cwd);
    const [command = 'help', ...words] = args;

    const findRepo = async () => {
        try { return await git.findRoot({ fs, filepath: here }); } catch (_) {
            throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
        }
    };
    const globalConfig = async path => {
        try { return await git.getConfig({ fs, dir: GLOBAL_GITDIR, gitdir: GLOBAL_GITDIR, path }); } catch (_) { return undefined; }
    };
    const setting = async (dir, path) => {
        const local = dir ? await git.getConfig({ fs, dir, path }).catch(() => undefined) : undefined;
        return local !== undefined ? local : globalConfig(path);
    };
    const corsProxy = async dir => (await setting(dir, 'http.corsProxy')) || ctx.serverProxy() || PUBLIC_PROXY;
    const author = async dir => {
        const name = await setting(dir, 'user.name'), email = await setting(dir, 'user.email');
        if (!name || !email) {
            throw new GitError('Author identity unknown: tell git who you are with\n'
                + '  git config --global user.name "Your Name"\n  git config --global user.email you@example.com');
        }
        return { name, email };
    };
    const onAuth = async url => {
        let lines = [];
        try { lines = decoder.decode(await root.readFile(CREDENTIALS)).split('\n'); } catch (_) { /* none */ }
        const host = new URL(url).host;
        for (const line of lines) {
            try {
                const u = new URL(line.trim());
                if (u.host === host) return { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
            } catch (_) { /* not a URL */ }
        }
        io.err(`git: no credentials for ${host} in /etc/${CREDENTIALS.slice(4)}\n`);
        return { cancel: true };
    };
    let progressShown = false;
    const onProgress = ({ phase, loaded, total }) => {
        progressShown = true;
        io.err(`\r\x1b[K${phase}: ${total ? `${Math.round(100 * loaded / total)}% (${loaded}/${total})` : loaded}`);
    };
    const endProgress = () => { if (progressShown) { io.err('\r\x1b[K'); progressShown = false; } };
    const net = async dir => ({ http, onProgress, onAuth, corsProxy: await corsProxy(dir) });
    const short = oid => oid.slice(0, 7);

    switch (command) {
        case 'help': case '--help': case '-h':
            out(HELP);
            return 0;
        case 'version': case '--version':
            out(`git version isomorphic-git ${git.version ? git.version() : GIT_VERSION}\n`);
            return 0;

        case 'init': {
            const { opts, rest } = parse(words, ['b', 'initial-branch']);
            const dir = rest[0] ? '/' + inRepo('', cwd, rest[0]) : here;
            await git.init({ fs, dir, defaultBranch: opts.b || opts['initial-branch'] || 'main' });
            out(`Initialized empty Git repository in ${dir.replace(/\/$/, '')}/.git/\n`);
            return 0;
        }

        case 'clone': {
            const { opts, rest } = parse(words, ['depth', 'b', 'branch', 'origin', 'o']);
            if (!rest[0]) throw new GitError('usage: git clone <url> [<dir>]', 129);
            const url = /^[\w.-]+\/[\w.-]+$/.test(rest[0]) ? `https://github.com/${rest[0]}` : rest[0];
            const name = rest[1] || url.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop();
            const dir = '/' + inRepo('', cwd, name);
            try {
                if ((await fs.promises.readdir(dir)).length) throw new GitError(`fatal: destination path '${name}' already exists and is not an empty directory.`);
            } catch (err) { if (err instanceof GitError) throw err; }
            io.err(`Cloning into '${name}'...\n`);
            await git.clone({
                fs, dir, url, ...(await net(null)),
                ref: opts.b || opts.branch,
                remote: opts.o || opts.origin || 'origin',
                depth: opts.depth ? Number(opts.depth) : undefined,
                singleBranch: !!opts['single-branch'] || !!opts.depth,
                noCheckout: !!opts['no-checkout'],
            });
            endProgress();
            return 0;
        }

        case 'status': {
            const { opts } = parse(words);
            const dir = await findRepo();
            const rows = await git.statusMatrix({ fs, dir });
            const lines = [];
            for (const [file, head, work, stage] of rows) {
                if (head === 1 && work === 1 && stage === 1) continue;
                if (head === 0 && stage === 0) { lines.push(`?? ${file}`); continue; }
                const x = head === 0 ? 'A' : stage === 0 ? 'D' : stage === 1 ? ' ' : 'M';
                const y = work === 0 ? (stage === 0 ? ' ' : 'D') : stage === 3 || (work === 2 && stage === 1) ? 'M' : ' ';
                lines.push(`${x}${y} ${file}`);
            }
            if (!opts.s && !opts.short && !opts.porcelain) {
                const branch = await git.currentBranch({ fs, dir });
                out(branch ? `On branch ${branch}\n` : 'HEAD detached\n');
                if (!lines.length) out('nothing to commit, working tree clean\n');
            }
            if (lines.length) out(lines.join('\n') + '\n');
            return 0;
        }

        case 'add': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            if (opts.A || opts.all || rest.includes('.') && inRepo(dir, cwd, '.') === '') {
                for (const [file, , work, stage] of await git.statusMatrix({ fs, dir })) {
                    if (work === 0 && stage !== 0) await git.remove({ fs, dir, filepath: file });
                    else if (work !== 0 && work !== stage) await git.add({ fs, dir, filepath: file });
                }
                return 0;
            }
            if (!rest.length) throw new GitError('Nothing specified, nothing added.', 0);
            for (const p of rest) {
                const filepath = inRepo(dir, cwd, p) || '.';
                try { await fs.promises.lstat(`${dir}/${filepath}`); } catch (_) {
                    await git.remove({ fs, dir, filepath });
                    continue;
                }
                await git.add({ fs, dir, filepath });
            }
            return 0;
        }

        case 'rm': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            for (const p of rest) {
                const filepath = inRepo(dir, cwd, p);
                await git.remove({ fs, dir, filepath });
                if (!opts.cached) await fs.promises.unlink(`${dir}/${filepath}`).catch(() => {});
                out(`rm '${filepath}'\n`);
            }
            return 0;
        }

        case 'commit': {
            const { opts } = parse(words, ['m', 'message']);
            const dir = await findRepo();
            const message = (opts.m || []).concat(opts.message || []).join('\n\n');
            if (opts.a || opts.all) {
                for (const [file, head, work, stage] of await git.statusMatrix({ fs, dir })) {
                    if (head === 0) continue;
                    if (work === 0 && stage !== 0) await git.remove({ fs, dir, filepath: file });
                    else if (work === 2 && stage !== 2) await git.add({ fs, dir, filepath: file });
                }
            }
            let parent;
            if (opts.amend) parent = (await git.readCommit({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: 'HEAD' }) })).commit;
            if (!message && !opts.amend) throw new GitError('Aborting commit due to empty commit message (git commit -m <message>).', 1);
            const who = await author(dir);
            const oid = await git.commit({
                fs, dir, author: who, message: message || parent.message,
                ...(parent ? { parent: parent.parent } : {}),
            });
            const branch = await git.currentBranch({ fs, dir });
            out(`[${branch || 'detached HEAD'} ${short(oid)}] ${(message || parent.message).split('\n')[0]}\n`);
            return 0;
        }

        case 'log': {
            const { opts, rest } = parse(words, ['n', 'max-count']);
            const dir = await findRepo();
            const n = opts.n || opts['max-count'] || (/^-\d+$/.test(rest[0] || '') ? rest.shift().slice(1) : undefined);
            const commits = await git.log({ fs, dir, ref: rest[0] || 'HEAD', depth: n ? Number(n) : undefined });
            for (const { oid, commit } of commits) {
                if (opts.oneline) { out(`${short(oid)} ${commit.message.split('\n')[0]}\n`); continue; }
                const date = new Date(commit.author.timestamp * 1000);
                out(`\x1b[33mcommit ${oid}\x1b[0m\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${date.toString()}\n\n`
                    + commit.message.replace(/\n+$/, '').split('\n').map(l => `    ${l}`).join('\n') + '\n\n');
            }
            return 0;
        }

        case 'branch': {
            const { opts, rest } = parse(words, ['d', 'D']);
            const dir = await findRepo();
            const del = opts.d || opts.D;
            if (del) { await git.deleteBranch({ fs, dir, ref: del }); out(`Deleted branch ${del}\n`); return 0; }
            if (rest[0]) { await git.branch({ fs, dir, ref: rest[0], object: rest[1] }); return 0; }
            const current = await git.currentBranch({ fs, dir });
            for (const b of await git.listBranches({ fs, dir })) out(b === current ? `* \x1b[32m${b}\x1b[0m\n` : `  ${b}\n`);
            if (opts.a || opts.r) {
                for (const remote of await git.listRemotes({ fs, dir })) {
                    for (const b of await git.listBranches({ fs, dir, remote: remote.remote })) out(`  \x1b[31mremotes/${remote.remote}/${b}\x1b[0m\n`);
                }
            }
            return 0;
        }

        case 'checkout': case 'switch': {
            const { opts, rest } = parse(words, ['b', 'c', 'B']);
            const dir = await findRepo();
            if (opts['--']) {
                const ref = rest.length > 1 && words.indexOf('--') > 0 && words[0] !== '--' ? rest.shift() : undefined;
                await git.checkout({ fs, dir, ref: ref || await git.currentBranch({ fs, dir }) || 'HEAD', filepaths: rest.map(p => inRepo(dir, cwd, p)), force: true });
                return 0;
            }
            const create = opts.b || opts.c || opts.B;
            if (create) {
                await git.branch({ fs, dir, ref: create, object: rest[0], checkout: true, force: !!opts.B });
                io.err(`Switched to a new branch '${create}'\n`);
                return 0;
            }
            if (!rest[0]) throw new GitError(`usage: git ${command} <branch>`, 129);
            await git.checkout({ fs, dir, ref: rest[0], onProgress, force: !!opts.f || !!opts.force });
            endProgress();
            io.err(`Switched to '${rest[0]}'\n`);
            return 0;
        }

        case 'merge': {
            const { rest } = parse(words);
            const dir = await findRepo();
            if (!rest[0]) throw new GitError('usage: git merge <branch>', 129);
            const ours = await git.currentBranch({ fs, dir });
            const result = await git.merge({ fs, dir, ours, theirs: rest[0], author: await author(dir) });
            if (result.alreadyMerged) { out('Already up to date.\n'); return 0; }
            await git.checkout({ fs, dir, ref: ours });
            out(result.fastForward ? `Fast-forward to ${short(result.oid)}\n` : `Merge made: ${short(result.oid)}\n`);
            return 0;
        }

        case 'reset': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            if (opts.hard || (!rest.length && !opts.soft)) {
                const oid = await git.resolveRef({ fs, dir, ref: rest[0] || 'HEAD' }).catch(() => git.expandOid({ fs, dir, oid: rest[0] }));
                const branch = await git.currentBranch({ fs, dir, fullname: true });
                if (branch) await git.writeRef({ fs, dir, ref: branch, value: oid, force: true });
                if (opts.hard) {
                    await git.checkout({ fs, dir, ref: branch ? branch.replace(/^refs\/heads\//, '') : oid, force: true });
                    out(`HEAD is now at ${short(oid)}\n`);
                } else {
                    for (const [file] of await git.statusMatrix({ fs, dir })) await git.resetIndex({ fs, dir, filepath: file });
                }
                return 0;
            }
            for (const p of rest) await git.resetIndex({ fs, dir, filepath: inRepo(dir, cwd, p) });
            return 0;
        }

        case 'fetch': {
            const { opts, rest } = parse(words, ['depth']);
            const dir = await findRepo();
            const result = await git.fetch({
                fs, dir, ...(await net(dir)), remote: rest[0] || 'origin', ref: rest[1],
                depth: opts.depth ? Number(opts.depth) : undefined, tags: !!opts.tags, singleBranch: !!rest[1],
            });
            endProgress();
            if (result.fetchHead) out(`${short(result.fetchHead)} ${result.fetchHeadDescription || ''}\n`);
            return 0;
        }

        case 'pull': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            const ref = rest[1] || await git.currentBranch({ fs, dir });
            await git.pull({
                fs, dir, ...(await net(dir)), remote: rest[0] || 'origin', ref, singleBranch: true,
                fastForwardOnly: !!opts['ff-only'], author: await author(dir).catch(() => ({ name: 'git', email: 'git@localhost' })),
            });
            endProgress();
            out('Pulled.\n');
            return 0;
        }

        case 'push': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            const result = await git.push({
                fs, dir, ...(await net(dir)), remote: rest[0] || 'origin',
                ref: rest[1] || await git.currentBranch({ fs, dir }), force: !!(opts.f || opts.force),
            });
            endProgress();
            for (const [ref, r] of Object.entries(result.refs || {})) out(`${r.ok ? ' ' : '!'} ${ref}${r.error ? ': ' + r.error : ''}\n`);
            return result.ok ? 0 : 1;
        }

        case 'remote': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            if (rest[0] === 'add') { await git.addRemote({ fs, dir, remote: rest[1], url: rest[2] }); return 0; }
            if (rest[0] === 'remove' || rest[0] === 'rm') { await git.deleteRemote({ fs, dir, remote: rest[1] }); return 0; }
            for (const { remote, url } of await git.listRemotes({ fs, dir })) {
                out(opts.v ? `${remote}\t${url} (fetch)\n${remote}\t${url} (push)\n` : `${remote}\n`);
            }
            return 0;
        }

        case 'tag': {
            const { opts, rest } = parse(words, ['m', 'd']);
            const dir = await findRepo();
            if (opts.d) { await git.deleteTag({ fs, dir, ref: opts.d }); out(`Deleted tag '${opts.d}'\n`); return 0; }
            if (!rest[0]) { for (const t of await git.listTags({ fs, dir })) out(t + '\n'); return 0; }
            if (opts.a || opts.m) {
                await git.annotatedTag({ fs, dir, ref: rest[0], object: rest[1], message: (opts.m || []).join('\n\n'), tagger: await author(dir) });
            } else {
                await git.tag({ fs, dir, ref: rest[0], object: rest[1] });
            }
            return 0;
        }

        case 'config': {
            const { opts, rest } = parse(words);
            const dir = opts.global ? GLOBAL_GITDIR : await findRepo();
            const gitdir = opts.global ? GLOBAL_GITDIR : undefined;
            if (opts.global) await root.makeDir(GLOBAL_GITDIR.slice(1)).catch(() => {});
            if (opts.list || opts.l) {
                const file = opts.global ? `${GLOBAL_GITDIR}/config` : `${dir}/.git/config`;
                const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
                out(text && !text.endsWith('\n') ? text + '\n' : text);
                return 0;
            }
            if (!rest[0]) throw new GitError('usage: git config [--global] <key> [<value>]', 129);
            if (opts.unset) { await git.setConfig({ fs, dir, gitdir, path: rest[0], value: undefined }); return 0; }
            if (rest.length > 1) { await git.setConfig({ fs, dir, gitdir, path: rest[0], value: rest.slice(1).join(' ') }); return 0; }
            const value = await git.getConfig({ fs, dir, gitdir, path: rest[0] });
            if (value === undefined) return 1;
            out(value + '\n');
            return 0;
        }

        case 'rev-parse': {
            const { opts, rest } = parse(words);
            const dir = await findRepo();
            if (opts['show-toplevel']) { out(dir + '\n'); return 0; }
            for (const ref of rest) {
                if (opts['abbrev-ref'] && ref === 'HEAD') out((await git.currentBranch({ fs, dir }) || 'HEAD') + '\n');
                else out(await git.resolveRef({ fs, dir, ref }).catch(() => git.expandOid({ fs, dir, oid: ref })) + '\n');
            }
            return 0;
        }

        case 'ls-files': {
            const dir = await findRepo();
            for (const f of await git.listFiles({ fs, dir })) out(f + '\n');
            return 0;
        }

        case 'show-ref': {
            const dir = await findRepo();
            for (const prefix of ['refs/heads', 'refs/tags']) {
                const names = prefix === 'refs/heads' ? await git.listBranches({ fs, dir }) : await git.listTags({ fs, dir });
                for (const n of names) out(`${await git.resolveRef({ fs, dir, ref: `${prefix}/${n}` })} ${prefix}/${n}\n`);
            }
            return 0;
        }

        default:
            throw new GitError(`git: '${command}' is not a git command here. See 'git help'.`, 1);
    }
}

// The runner of /etc/tools: git [args…], in the folder dir of the namespace
function gitRunner(root, dir, args, io, done, ctx) {
    let finished = false;
    const finish = code => { if (!finished) { finished = true; done(code); } };
    runGit(root, dir, args, io, ctx).then(finish, err => {
        io.err('\r\x1b[K');
        const message = String((err && err.message) || err);
        io.err((err instanceof GitError || /^fatal:/.test(message) ? message : `fatal: ${message}`) + '\n');
        finish(err && err.exitCode !== undefined ? err.exitCode : 128);
    });
    return { input: null, stop() { finish(130); } };
}

module.exports = { gitRunner };
