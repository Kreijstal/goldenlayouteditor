// FFmpeg in a worker, for Amiga IFF and FLIC animations (src/iffanim.js) and X Window
// dumps (src/xwd.js): ffmpeg.wasm's
// core (@ffmpeg/core, FFmpeg compiled to WebAssembly), its 32 MB .wasm fetched
// from jsDelivr the first time one is opened. FFmpeg's iff demuxer and iff_ilbm
// decoder read an ANIM's first ILBM and its DLTA deltas (ANHD's operations 0-5,
// 7 and 8 short and long, J, l...), HAM and EHB included; Deluxe Paint's PC
// animations (.anm, LPF) are FFmpeg's too, and so are Autodesk Animator's FLICs
// (flic demuxer and decoder: FLI's 64-level palettes, FLC's 256, Animator Pro's
// 15/16/24-bit FLX frames). X Window dumps are its xwd_pipe demuxer's and xwd
// decoder's (ZPixmap dumps only).
//   → { id, bytes, frames }     ← { id, raw, times, log } | { id, error }
// raw: the first `frames` frames' RGBA, one after another; times: FFmpeg's
// framecrc of them (the time base, the size, the pixel aspect, each frame's pts).
const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
importScripts(CORE + 'ffmpeg-core.js');

let loading = null;
let queue = Promise.resolve();

function load() {
    if (!loading) {
        // the core finds its .wasm by the URL given after the script's '#'
        const where = btoa(JSON.stringify({ wasmURL: CORE + 'ffmpeg-core.wasm', workerURL: '' }));
        loading = self.createFFmpegCore({ mainScriptUrlOrBlob: CORE + 'ffmpeg-core.js#' + where });
        loading.catch(() => { loading = null; });
    }
    return loading;
}

async function decode(bytes, frames) {
    const ff = await load();
    const log = [];
    ff.setLogger(({ message }) => log.push(message));
    ff.FS.writeFile('in', bytes);
    try {
        // every frame as it comes (no frames repeated or dropped to a constant rate)
        const n = String(frames);
        const ret = ff.exec('-i', 'in',
            '-vsync', 'passthrough', '-frames:v', n, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'out.raw',
            '-vsync', 'passthrough', '-frames:v', n, '-f', 'framecrc', 'times.txt');
        ff.reset();
        if (ret !== 0) throw new Error(log.filter(l => /error|invalid|corrupt/i.test(l)).pop() || `FFmpeg failed (${ret})`);
        const raw = ff.FS.readFile('out.raw');
        const times = new TextDecoder().decode(ff.FS.readFile('times.txt'));
        return { raw, times, log };
    } finally {
        for (const f of ['in', 'out.raw', 'times.txt']) {
            try { ff.FS.unlink(f); } catch { /* not written */ }
        }
    }
}

self.onmessage = ({ data: { id, bytes, frames } }) => {
    // one FFmpeg run at a time
    queue = queue.then(() => decode(bytes, frames)).then(
        r => self.postMessage({ id, ...r }, [r.raw.buffer]),
        err => self.postMessage({ id, error: err.message || String(err) }));
};
