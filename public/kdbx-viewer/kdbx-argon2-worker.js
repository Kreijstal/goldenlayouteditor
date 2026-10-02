// Argon2 for KDBX 4 key derivation, off the page's thread so the tab stays
// responsive while it runs (64 MiB and several passes by default). One worker
// per unlock, terminated afterwards, which also frees its memory. hash-wasm's
// argon2 is a ~7 KB wasm built with plain clang (--target=wasm32 -nostdlib),
// no emscripten runtime; see kdbx-viewer.js.
import { argon2d, argon2id } from 'https://esm.sh/hash-wasm@4.12.0/dist/argon2.umd.min.js';

self.onmessage = async (e) => {
    const { password, salt, memory, iterations, length, parallelism, type } = e.data;
    try {
        const fn = type === 2 ? argon2id : argon2d;
        const hash = await fn({
            password: new Uint8Array(password), salt: new Uint8Array(salt),
            memorySize: memory, iterations, parallelism, hashLength: length, outputType: 'binary',
        });
        new Uint8Array(password).fill(0);
        self.postMessage({ hash }, [hash.buffer]);
    } catch (err) {
        self.postMessage({ error: String(err && err.message || err) });
    }
};
