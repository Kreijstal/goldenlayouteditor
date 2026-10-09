// JavaScript host for povrayst 0.1.0's wasm-minimal-protocol interface.
// A new worker/instance per render isolates POV-Ray globals and allows cancellation.
async function render({ scene, width, height }) {
    const response = await fetch('/povray-viewer/povray.wasm');
    if (!response.ok) throw new Error(`POV-Ray module: HTTP ${response.status}. Run npm run fetch:povray.`);
    const sceneBytes = new TextEncoder().encode(scene);
    const options = new TextEncoder().encode(`+W${width}\n+H${height}\n+Q9\n+A0.3\n-D\n+FN`);
    const args = new Uint8Array(sceneBytes.length + options.length);
    args.set(sceneBytes);
    args.set(options, sceneBytes.length);
    let instance, output;
    const imports = { typst_env: {
        wasm_minimal_protocol_write_args_to_buffer(pointer) {
            new Uint8Array(instance.exports.memory.buffer).set(args, pointer);
        },
        wasm_minimal_protocol_send_result_to_host(pointer, length) {
            output = new Uint8Array(instance.exports.memory.buffer).slice(pointer, pointer + length);
        },
    } };
    ({ instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports));
    instance.exports._initialize();
    const status = instance.exports.render(sceneBytes.length, options.length);
    if (status !== 0) throw new Error(new TextDecoder().decode(output));
    self.postMessage(output, [output.buffer]);
}
// Forward asynchronous failures across the worker boundary so the panel can report them.
self.onmessage = ({ data }) => render(data).catch(error => {
    self.postMessage({ error: error.message });
});
