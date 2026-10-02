#!/usr/bin/env python3
"""Runs CryptPad's x2t WebAssembly Dockerfile (github.com/cryptpad/onlyoffice-x2t-wasm)
without Docker: every stage gets its own root under stages/<name>/ holding the
paths the Dockerfile writes to (/core, /boost, /usr/local, /build_tools, /test,
...), and its RUN lines execute in bubblewrap with those folders mounted at
those paths over the host system. The base stage (apt + emsdk) is replaced by
the host's tools and the host's emscripten, laid out at /emsdk as an emsdk.

Usage: run-dockerfile.py CONTEXT_DIR TARGET_STAGE [--only STAGE]
"""
import os, re, shlex, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CTX = os.path.abspath(sys.argv[1])
TARGET = sys.argv[2]
ONLY = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else None
STAGES_DIR = os.path.join(HERE, 'stages')
# The host's emscripten (EMSCRIPTEN, default /usr/lib/emscripten) stands in for the
# recipe's emsdk: emsdk-host/ holds an emsdk_env.sh for it and the emscripten cache,
# which the recipe expects at /emsdk/upstream/emscripten/cache (boost installs there)
EMSCRIPTEN = os.environ.get('EMSCRIPTEN', '/usr/lib/emscripten')
EMSDK = os.path.join(HERE, 'emsdk-host')
TOOLS = os.path.join(HERE, 'tools')  # qmake -> qmake6, lbzip2 -> bzip2, embuild.sh
SKIP = {'documentserver', 'testfiles', 'test', 'test-output', 'log-symbols', 'log-symbols-output', 'output'}
# Top-level paths a stage may own (everything else comes from the host)
OWNED = ['core', 'boost', 'usr/local', 'build_tools', 'test', 'tests', 'openssl']


def parse(path):
    text = open(path).read().replace('\\\n', ' ')
    stages, cur = {}, None
    order = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        word, _, rest = line.partition(' ')
        word = word.upper()
        if word == 'FROM':
            m = re.match(r'(\S+)(?:\s+AS\s+(\S+))?', rest, re.I)
            cur = {'name': m.group(2) or m.group(1), 'parent': m.group(1), 'steps': []}
            stages[cur['name']] = cur
            order.append(cur['name'])
        elif cur is not None:
            cur['steps'].append((word, rest.strip()))
    return stages, order


def deps(stage):
    out = []
    for word, rest in stage['steps']:
        m = re.search(r'--from=(\S+)', rest)
        if word == 'COPY' and m:
            out.append(m.group(1))
    if stage['parent'] in STAGES:
        out.append(stage['parent'])
    return out


def root_of(name):
    return os.path.join(STAGES_DIR, name)


def host_path(root, path):
    """Where a container path lives: in the stage root if owned, else on the host."""
    rel = path.lstrip('/')
    for o in OWNED:
        if rel == o or rel.startswith(o + '/'):
            return os.path.join(root, rel)
    if rel.startswith('emsdk'):
        return os.path.join(EMSDK, rel[len('emsdk'):].lstrip('/'))
    return os.path.join(root, 'rootfiles', rel)  # e.g. /pre-js.js, /bin/embuild.sh


def copy(src, dst, hardlink=False):
    if os.path.isdir(src):
        os.makedirs(dst, exist_ok=True)
        subprocess.run(['cp', '-a' + ('l' if hardlink else ''), src + '/.', dst + '/'], check=True)
    else:
        if dst.endswith('/') or os.path.isdir(dst):
            os.makedirs(dst, exist_ok=True)
            dst = os.path.join(dst, os.path.basename(src))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            os.remove(dst)
        if hardlink:
            os.link(src, dst)
        else:
            shutil.copy2(src, dst)


def setup_emsdk():
    if not os.path.isdir(os.path.join(EMSCRIPTEN, 'cache')):
        raise SystemExit(f'{EMSCRIPTEN}/cache is missing: the cache is mounted there')
    os.makedirs(os.path.join(EMSDK, 'upstream/emscripten'), exist_ok=True)
    os.makedirs(os.path.join(EMSDK, 'cache'), exist_ok=True)
    node = os.path.dirname(os.path.realpath(shutil.which('node')))  # npm sits next to it
    with open(os.path.join(EMSDK, 'emsdk_env.sh'), 'w') as f:
        f.write('export EMSDK=/emsdk EM_CACHE=/emsdk/upstream/emscripten/cache\n'
                f'export PATH=/emsdk/upstream/emscripten:{node}:$PATH\n')


def bwrap_cmd(root, workdir, env):
    cmd = ['bwrap', '--die-with-parent', '--tmpfs', '/']
    for entry in os.listdir('/'):
        p = '/' + entry
        if entry in ('proc', 'dev', 'tmp') or entry.startswith('$'):
            continue
        if os.path.islink(p):
            cmd += ['--symlink', os.readlink(p), p]
        elif os.path.isdir(p):
            cmd += ['--bind', p, p]
    cmd += ['--proc', '/proc', '--dev', '/dev', '--bind', '/tmp', '/tmp']
    for sub in ('bin', 'lib', 'include', 'share'):  # as on a stock system
        os.makedirs(os.path.join(root, 'usr/local', sub), exist_ok=True)
    for o in OWNED:
        src = os.path.join(root, o)
        os.makedirs(src, exist_ok=True)
        cmd += ['--bind', src, '/' + o]
    cmd += ['--bind', EMSDK, '/emsdk',
            '--ro-bind', EMSCRIPTEN, '/emsdk/upstream/emscripten',
            '--bind', os.path.join(EMSDK, 'cache'), '/emsdk/upstream/emscripten/cache']
    # Loose files the Dockerfile puts at the top level (/pre-js.js, /wrap-main.cpp)
    rf = os.path.join(root, 'rootfiles')
    if os.path.isdir(rf):
        for entry in os.listdir(rf):
            if entry in ('bin',):
                continue
            cmd += ['--bind', os.path.join(rf, entry), '/' + entry]
    os.makedirs(workdir_host(root, workdir), exist_ok=True)
    cmd += ['--chdir', workdir]
    for k, v in env.items():
        cmd += ['--setenv', k, v]
    return cmd


def workdir_host(root, wd):
    return host_path(root, wd) if wd != '/' else root


def run_stage(name):
    st = STAGES[name]
    root = root_of(name)
    done = os.path.join(root, '.done')
    if os.path.exists(done):
        print(f'== {name}: done already')
        return
    print(f'== {name}', flush=True)
    if os.path.exists(root):
        shutil.rmtree(root)
    os.makedirs(root)
    parent = st['parent']
    if parent in STAGES and parent != 'base':
        for o in OWNED + ['rootfiles']:
            if os.path.exists(os.path.join(root_of(parent), o)):
                copy(os.path.join(root_of(parent), o), os.path.join(root, o), hardlink=True)
    env = {
        'PATH': TOOLS + ':/usr/local/bin:/usr/bin',
        'HOME': os.path.join(root, 'home'),
        'QT_SELECT': 'qt6',
        'QMAKEFEATURES': os.path.join(TOOLS, 'qmake-features'),
        'LANG': 'C.UTF-8',
        'MAKEFLAGS': '-j16',
    }
    os.makedirs(env['HOME'], exist_ok=True)
    wd = '/'
    for word, rest in st['steps']:
        if word == 'WORKDIR':
            wd = rest if rest.startswith('/') else os.path.join(wd, rest)
        elif word == 'ENV':
            first = rest.split()[0]
            k, _, v = rest.partition('=') if '=' in first else rest.partition(' ')
            env[k.strip()] = v.strip()
        elif word == 'ARG':
            k, _, v = rest.partition('=')
            env.setdefault(k.strip(), v.strip())
        elif word == 'COPY':
            args = shlex.split(rest)
            frm = None
            if args[0].startswith('--from='):
                frm = args.pop(0)[len('--from='):]
            *srcs, dst = args
            if not dst.startswith('/'):
                dst = os.path.join(wd, dst)
            for s in srcs:
                if frm:
                    src = host_path(root_of(frm), s)
                else:
                    src = os.path.join(CTX, s)
                target = host_path(root, dst)
                if dst.endswith('/') or (os.path.isdir(src) and not os.path.isfile(target)):
                    if os.path.isdir(src):
                        copy(src, target, hardlink=True)
                    else:
                        copy(src, target.rstrip('/') + '/', hardlink=True)
                else:
                    copy(src, target, hardlink=True)
        elif word == 'RUN':
            cmdline = re.sub(r'--mount=\S+\s*', '', rest).strip()
            # The stage's own folders (/test, ...) exist already, being mount points
            cmdline = re.sub(r'\bmkdir (?!-p)', 'mkdir -p ', cmdline)
            print(f'   $ {cmdline[:150]}', flush=True)
            # Sources are hard links to a read-only copy: a file appended to or copied
            # over in place gets its own copy first
            targets = re.findall(r'>>\s*(\S+)', cmdline)
            for part in re.split(r'&&|\|\||;', cmdline):
                try:
                    words = shlex.split(part)
                except ValueError:
                    continue
                if words and words[0] == 'cp' and len(words) >= 3 and not words[-1].endswith('/'):
                    targets.append(words[-1])
            for target in targets:
                h = host_path(root, target if target.startswith('/') else os.path.join(wd, target))
                if os.path.isfile(h) and not os.path.islink(h):
                    tmp = h + '.own'
                    shutil.copy2(h, tmp)
                    os.chmod(tmp, 0o644)
                    os.replace(tmp, h)
            r = subprocess.run(bwrap_cmd(root, wd, env) + ['bash', '-c', 'set -e; ' + cmdline])
            if r.returncode:
                print(f'!! {name}: RUN failed ({r.returncode}): {cmdline[:200]}', flush=True)
                raise SystemExit(1)
        elif word in ('SHELL', 'LABEL', 'EXPOSE', 'CMD', 'ENTRYPOINT', 'USER', 'VOLUME'):
            pass
        else:
            print(f'   (ignored {word} {rest[:80]})')
    open(done, 'w').close()


setup_emsdk()
STAGES, ORDER = parse(os.path.join(CTX, 'Dockerfile'))
seen = []


def visit(n):
    if n in seen or n not in STAGES or n == 'base' or n in SKIP:
        return
    for d in deps(STAGES[n]):
        visit(d)
    seen.append(n)


def run_all(order, jobs):
    """Stages whose dependencies are done run side by side, up to `jobs` at a time."""
    import concurrent.futures as cf
    need = {n: [d for d in deps(STAGES[n]) if d in order] for n in order}
    done, running = set(), {}
    with cf.ThreadPoolExecutor(jobs) as pool:
        while len(done) < len(order):
            for n in order:
                if n not in done and n not in running and len(running) < jobs and all(d in done for d in need[n]):
                    running[n] = pool.submit(run_stage, n)
            finished, _ = cf.wait(running.values(), return_when=cf.FIRST_COMPLETED)
            for n, f in list(running.items()):
                if f in finished:
                    f.result()  # a failed stage ends the build (sys.exit in run_stage)
                    done.add(n)
                    del running[n]


if ONLY:
    run_stage(ONLY)
else:
    visit(TARGET)
    print('stages:', ' '.join(seen), flush=True)
    run_all(seen, int(os.environ.get('STAGE_JOBS', '3')))
