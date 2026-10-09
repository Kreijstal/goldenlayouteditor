const { registerPlugin } = require('./plugins');
const { resolveAssetUrl } = require('./lazy-viewers');
const { readBytes, element } = require('./imported-viewer-panel');
const renderIdml = require('./imported-idml/viewer').default;
let ctx;
class IdmlPanel {
    constructor(container, state) {
        this.destroyed = false;
        this.root = container.element;
        this.root.style.cssText += ';height:100%;display:flex;flex-direction:column;overflow:hidden;background:#20242a;color:#eee;font:14px system-ui';
        const bar = element('div'); bar.style.cssText='padding:8px;display:flex;align-items:center;gap:12px';
        const open = element('button','Open IDML',bar);
        const input = element('input',undefined,bar); input.type='file'; input.accept='.idml'; input.hidden=true;
        this.label=element('span','Choose an InDesign IDML document',bar);
        this.host=element('div');this.host.style.cssText='flex:1;min-height:0;overflow:hidden';
        this.root.replaceChildren(bar,this.host);
        open.onclick=()=>input.click();
        input.onchange=async()=>{const file=input.files[0];if(file)await this.show(new Uint8Array(await file.arrayBuffer()),file.name);};
        container.on('destroy',()=>{this.destroyed=true;this.close();this.host.replaceChildren();});
        this.ready=this.init(state || {});
    }
    async init(state) {
        if(!state.fileId)return;
        const file=ctx.projectFiles[state.fileId];
        if(!file)throw new Error('File no longer exists: '+state.fileId);
        await this.show(await readBytes(file,ctx),file.name);
    }
    close() {
        this.abort?.abort();this.view?.unmount();this.view=null;
    }
    async show(bytes,name) {
        if(this.destroyed)return;
        this.close();
        const abort = new AbortController();this.abort=abort;
        const host=element('div');host.style.cssText='height:100%;min-height:0';
        this.host.replaceChildren(host);this.label.textContent=name+' · reading…';
        const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
        const view=await renderIdml(buffer,host,{signal:abort.signal,options:{locale:'en',design:{
            idmlWorkerUrl:resolveAssetUrl('idml-viewer/worker.js'),
            idmlWasmUrl:resolveAssetUrl('idml-viewer/introspect.wasm'),
        }}});
        if(this.destroyed || abort.signal.aborted){view.unmount();return;}
        this.view=view;this.label.textContent=name;
    }
}
registerPlugin({id:'idml',name:'InDesign IDML',components:{idmlViewer:IdmlPanel},
    toolbarButtons:[{label:'IDML',title:'Open InDesign IDML',menuLabel:'InDesign IDML document (.idml)'}],
    init(context){ctx=context;}});
