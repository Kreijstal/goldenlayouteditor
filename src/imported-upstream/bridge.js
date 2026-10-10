// Trusted shell around the pinned MIT jdeworks readers. Source previews retain
// the upstream opaque-origin iframe; input scripts remain disabled.
import {REGISTRY} from './core/registry-runtime.generated.js';
import {intakeFromBytes} from './core/intake.js';
import {descriptorsFor,previewStyle} from './core/settings-schema.js';
import {mountPreview} from './core/iframe.js';
const nativeCreate=URL.createObjectURL.bind(URL),nativeRevoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=nativeCreate(blob);if(current)current.urls.add(url);return url;};
URL.revokeObjectURL=url=>{current?.urls.delete(url);nativeRevoke(url);};
const LIMITS={f3d:'Saved thumbnail, manifest and archive contents only; geometry is not reconstructed.',sketch:'Saved preview and document structure; vector layout is not reconstructed.',procreate:'Saved thumbnail only; layers and full canvas are not reconstructed.',mat:'MAT v5 uncompressed variable metadata only; array values are not decoded.',exe:'Executable header inspection only; code is not executed or disassembled.',pyc:'Python bytecode header inspection only; code is not executed or disassembled.'};
const nonce=new URL(location.href).searchParams.get('nonce');const host=document.getElementById('host'),label=document.getElementById('label');let generation=0,current=null;
function release(){if(!current)return;current.controller.abort();for(const fn of [...current.cleanups].reverse())fn();for(const url of current.urls)nativeRevoke(url);current=null;host.replaceChildren();}
async function open(bytes,name,id){
 release();const seq=++generation,controller=new AbortController(),cleanups=new Set();current={controller,cleanups,urls:new Set()};const stale=()=>seq!==generation||controller.signal.aborted;
 const intake=intakeFromBytes(bytes,name);if(/\.(bson|cbor|msgpack|mpk|f3d|f3z|sketch|procreate|mat|dbf|exe|dll|dylib|macho|class|pyc|pyo|lnk|torrent)$/i.test(name))intake.isBinary=true;
 if(/\.bson$/i.test(name)&&(bytes.length<5||new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getInt32(0,true)!==bytes.length||bytes[bytes.length-1]!==0))throw Error('Invalid BSON document length or terminator');const ranked=REGISTRY.map(type=>({type,score:type.detect(intake)||0})).sort((a,b)=>b.score-a.score),best=ranked[0];if(!best||!best.score)throw Error('No upstream reader recognized '+name);const type=best.type;label.textContent=type.label;const limitation=LIMITS[type.id];if(limitation){const notice=document.createElement('p');notice.textContent=limitation;host.append(notice);}
 const settings=Object.fromEntries(descriptorsFor(type).map(d=>[d.key,d.default]));if(type.settingsUrl){const response=await fetch(type.settingsUrl,{signal:controller.signal});if(!response.ok)throw Error('Reader settings: HTTP '+response.status);const config=await response.json();for(const [key,value] of Object.entries(config.values||{}))if(Object.hasOwn(settings,key))settings[key]=value;}
 if(stale())return;
 const onCleanup=fn=>{if(stale()){fn();return()=>{};}cleanups.add(fn);return()=>cleanups.delete(fn);};let rendered;
 if(type.loadRenderer){const reader=await type.loadRenderer();if(stale())return;rendered=await reader.render(intake,{settings,signal:controller.signal,onCleanup,allowScripts:false,openIntake:inner=>open(inner.bytes,inner.filename,id),toast:message=>{if(!stale())label.textContent=String(message);}});}
 else if(type.capabilities?.rawView){const pre=document.createElement('pre');pre.textContent=intake.text;rendered={parentNode:pre};}
 else throw Error('This reader has no preview or text view');
 for(const key of ['archiveCleanup','revoke','destroy'])if(rendered[key])onCleanup(rendered[key]);if(stale())return;
 if(rendered.parentNode)host.append(rendered.parentNode);else{
 // Opaque preview frames cannot fetch a blob owned by the trusted shell's
 // storage partition. Inline those image bytes before crossing that boundary.
 if(rendered.bodyHtml){const template=document.createElement('template');template.innerHTML=rendered.bodyHtml;for(const img of template.content.querySelectorAll('img[src^="blob:"]')){const response=await fetch(img.src,{signal:controller.signal});if(!response.ok)throw Error('Could not read preview image');const blob=await response.blob();img.src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}rendered.bodyHtml=template.innerHTML;if(stale())return;}
const preview=mountPreview(host,{bodyHtml:rendered.bodyHtml,fullDoc:rendered.fullDoc,allowScripts:!!rendered.ranScripts,extraHead:rendered.extraHead||'',theme:'light',style:previewStyle(settings),readerPrefs:rendered.readerPrefs,onOpen:rendered.openEntry?async path=>{const entry=await rendered.openEntry(path);if(!stale())await open(entry.bytes,entry.filename||path,id);}:undefined});onCleanup(()=>preview.destroy());}
 parent.postMessage({readerBridge:true,nonce,id,model:{typeId:type.id,label:type.label,summary:type.label}},location.origin);
}
window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||!event.data?.readerBridge||event.data.nonce!==nonce)return;const {bytes,name,id}=event.data;open(bytes,name,id).catch(error=>{if(error.name==='AbortError')return;label.textContent=error.message;parent.postMessage({readerBridge:true,nonce,id,error:error.message},location.origin);});});
window.addEventListener('pagehide',release);

parent.postMessage({readerBridge:true,nonce,ready:true},location.origin);
