const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
importScripts(CORE + 'ffmpeg-core.js');
let loading;
function load() {
    if (!loading) {
        const where = btoa(JSON.stringify({ wasmURL: CORE + 'ffmpeg-core.wasm', workerURL: '' }));
        loading = self.createFFmpegCore({ mainScriptUrlOrBlob: CORE + 'ffmpeg-core.js#' + where });
    }
    return loading;
}
self.onmessage = async ({ data }) => {
    try {
        const ff = await load(), log = [];
        ff.setLogger(({ message }) => { log.push(message); if (log.length > 100) log.shift(); });
        ff.FS.writeFile('input', new Uint8Array(data.bytes));
        const video = data.video, output = video ? 'output.mp4' : 'output.wav';
        try {
            const args = video
                ? ['-i', 'input', '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output]
                : ['-i', 'input', '-vn', '-c:a', 'pcm_s16le', '-f', 'wav', output];
            const result = ff.exec(...args); ff.reset();
            if (result !== 0) throw new Error(log.filter(l => /error|invalid|unsupported|not found/i.test(l)).pop() || `Media decoder failed (${result}).`);
            const bytes = ff.FS.readFile(output);
            self.postMessage({ bytes, mime: video ? 'video/mp4' : 'audio/wav' }, [bytes.buffer]);
        } finally { for (const name of ['input', output]) { try { ff.FS.unlink(name); } catch (_) { /* No output on failure. */ } } }
    } catch (err) { self.postMessage({ error: err.message }); }
};
