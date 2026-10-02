// A SoundFont synthesizer shared by the SoundFont viewer and the MIDI editor:
// spessasynth_lib (github.com/spessasus/spessasynth_lib), SF2/SF3/DLS in an
// AudioWorklet, loaded from esm.sh. One AudioContext and one synthesizer for
// the page; sound banks are loaded into it by path, the latest one first.
const LIB_VERSION = '4.3.14';
const CORE_VERSION = '4.3.22';
const LIB_URL = `https://esm.sh/spessasynth_lib@${LIB_VERSION}?deps=spessasynth_core@${CORE_VERSION}`;
const PROCESSOR_URL = `https://esm.sh/spessasynth_lib@${LIB_VERSION}/dist/spessasynth_processor.min.js?raw`;
const CORE_URL = `https://esm.sh/spessasynth_core@${CORE_VERSION}`;
// The sound banks the MIDI editor can play with, as opened in the viewer
const RECENT_KEY = 'gl-soundfonts';

let _core = null;
function loadCore() {
    if (!_core) _core = import(CORE_URL).catch(err => { _core = null; throw err; });
    return _core;
}

let _synth = null;
function getSynth() {
    if (!_synth) {
        _synth = (async () => {
            const { WorkletSynthesizer } = await import(LIB_URL);
            const context = new AudioContext();
            await context.audioWorklet.addModule(PROCESSOR_URL);
            const synth = new WorkletSynthesizer(context);
            synth.connect(context.destination);
            await synth.isReady;
            return { synth, context, banks: new Map() };
        })().catch(err => { _synth = null; throw err; });
    }
    return _synth;
}

// The bank at `path` in the synthesizer (bytes: its file), ahead of the others
async function useBank(path, bytes) {
    const s = await getSynth();
    if (!s.banks.has(path)) {
        s.banks.set(path, (async () => {
            const data = bytes || await fetch('/workspace-file?path=' + encodeURIComponent(path)).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return r.arrayBuffer();
            });
            // (the synthesizer takes the buffer over)
            await s.synth.soundBankManager.addSoundBank(data.slice(0), path);
        })().catch(err => { s.banks.delete(path); throw err; }));
    }
    await s.banks.get(path);
    const order = s.synth.soundBankManager.priorityOrder.filter(id => id !== path);
    s.synth.soundBankManager.priorityOrder = [path, ...order];
    if (s.context.state !== 'running') await s.context.resume();
    return s;
}

// Selects bank/program on a channel
function setPatch(synth, channel, program, bankMSB = 0, bankLSB = 0) {
    synth.controllerChange(channel, 0, bankMSB);
    synth.controllerChange(channel, 32, bankLSB);
    synth.programChange(channel, program);
}

function recentBanks() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; }
}

function rememberBank(path) {
    const list = [path, ...recentBanks().filter(p => p !== path)].slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* not kept */ }
    return list;
}

module.exports = { loadCore, getSynth, useBank, setPatch, recentBanks, rememberBank };
