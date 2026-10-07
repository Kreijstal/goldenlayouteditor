// --- Flash from a PDF, played by Ruffle in a frame of its own ---
// A movie in a PDF (RichMedia, as LaTeX's media9 makes) talks to the PDF
// through ExternalInterface: its controls call the movie's functions so. A
// movie may also call the page's: in our page it could reach the app, so it
// plays in a sandboxed frame with no origin, where it reaches only that frame.
// The movie's files (the video VPlayer.swf plays) are found by their names.

const { RUFFLE_URL, RUFFLE_PUBLIC_PATH } = require('./ruffle-plugin');

const FRAME = (ruffleUrl, publicPath) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}ruffle-player{display:block;width:100%;height:100%}</style>
<script>
window.RufflePlayer = { config: { publicPath: ${JSON.stringify(publicPath)}, autoplay: 'auto', allowScriptAccess: true,
    openUrlMode: 'confirm', warnOnUnsupportedContent: true, showSwfDownload: false } };
</script>
<script src="${ruffleUrl}" onerror="parent.postMessage({ pdfFlash: true, failed: 'Ruffle did not load' }, '*')"></script>
<script>
let player = null;
const reply = (id, value, error) => {
    try { parent.postMessage({ pdfFlash: true, id, value, error }, '*'); }
    catch (_) { parent.postMessage({ pdfFlash: true, id, value: null, error }, '*'); } // a value that can't be sent
};
const quote = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || !e.data.pdfFlash) return;
    const m = e.data;
    try {
        if (m.type === 'load') {
            player = RufflePlayer.newest().createPlayer();
            document.body.appendChild(player);
            // each file by its name, wherever the movie looks for it
            const base = 'https://pdf-assets.invalid/';
            const rules = [];
            for (const a of m.assets) {
                const url = URL.createObjectURL(new Blob([a.data]));
                for (const from of [base, document.baseURI]) {
                    try { rules.push([new RegExp('^' + quote(new URL(a.name.replace(/^\\//, ''), from).href) + '$', 'i'), url]); } catch (_) {}
                }
            }
            await player.load({ data: m.data, swfFileName: m.name, parameters: m.flashVars, allowScriptAccess: true,
                openUrlMode: 'confirm', base, urlRewriteRules: rules });
            reply(m.id, true);
        } else if (m.type === 'call') {
            // what the movie offered through ExternalInterface.addCallback
            const fn = player && Object.prototype.hasOwnProperty.call(player, m.name) ? player[m.name] : null;
            if (typeof fn !== 'function') throw new Error('the movie offers no ' + m.name);
            reply(m.id, fn.apply(player, m.args));
        }
    } catch (err) {
        reply(m.id, undefined, String((err && err.message) || err));
    }
});
parent.postMessage({ pdfFlash: true, ready: !!(window.RufflePlayer && RufflePlayer.newest) }, '*');
</script>`;

/**
 * Play a movie in `box`. Resolves when it is loaded, with { call(name, args), destroy() }.
 * @param {HTMLElement} box
 * @param {{data: Uint8Array, name: string, flashVars: string, assets: {name: string, data: Uint8Array}[]}} movie
 */
function playFlash(box, movie) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals');
    frame.setAttribute('allow', 'fullscreen; autoplay');
    frame.style.cssText = 'border:0;width:100%;height:100%;display:block;background:transparent;';
    frame.srcdoc = FRAME(RUFFLE_URL, RUFFLE_PUBLIC_PATH);
    let next = 0;
    const waiting = new Map();
    let ready;
    const readyP = new Promise((res, rej) => { ready = { res, rej }; });
    const onMessage = (e) => {
        if (e.source !== frame.contentWindow || !e.data || !e.data.pdfFlash) return;
        const m = e.data;
        if (m.failed) ready.rej(new Error(m.failed));
        else if ('ready' in m) m.ready ? ready.res() : ready.rej(new Error('Ruffle did not start'));
        else if (waiting.has(m.id)) {
            const w = waiting.get(m.id);
            waiting.delete(m.id);
            m.error ? w.rej(new Error(m.error)) : w.res(m.value);
        }
    };
    window.addEventListener('message', onMessage);
    const ask = (msg) => new Promise((res, rej) => {
        const id = ++next;
        waiting.set(id, { res, rej });
        frame.contentWindow.postMessage({ pdfFlash: true, id, ...msg }, '*');
    });
    const handle = {
        call: (name, args = []) => ask({ type: 'call', name, args }),
        destroy() {
            window.removeEventListener('message', onMessage);
            waiting.forEach(w => w.rej(new Error('stopped')));
            frame.remove();
        },
    };
    box.appendChild(frame);
    return readyP
        .then(() => ask({ type: 'load', data: movie.data, name: movie.name, flashVars: movie.flashVars, assets: movie.assets }))
        .then(() => handle, (err) => { handle.destroy(); throw err; });
}

module.exports = { playFlash };
