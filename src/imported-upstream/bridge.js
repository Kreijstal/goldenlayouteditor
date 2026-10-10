// Trusted shell around the pinned MIT jdeworks readers. Source previews retain
// the upstream opaque-origin iframe; input scripts remain disabled.
import {REGISTRY} from './core/registry-runtime.generated.js';
import {intakeFromBytes} from './core/intake.js';
import {descriptorsFor,previewStyle} from './core/settings-schema.js';
import {mountPreview} from './core/iframe.js';
const nonce=new URL(location.href).searchParams.get('nonce');const host=document.getElementById('host'),label=document.getElementById('label');let generation=0,current=null;
function release(){if(!current)return;current.controller.abort();for(const fn of [...current.cleanups].reverse())fn();current=null;host.replaceChildren();}
async function open(bytes,name,id){
 release();const seq=++generation,controller=new AbortController(),cleanups=new Set();current={controller,cleanups};const stale=()=>seq!==generation||controller.signal.aborted;
 const intake=intakeFromBytes(bytes,name);if(/\.(bson|cbor|msgpack|mpk)$/i.test(name))intake.isBinary=true;
 if(/\.bson$/i.test(name)&&(bytes.length<5||new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getInt32(0,true)!==bytes.length||bytes[bytes.length-1]!==0))throw Error('Invalid BSON document length or terminator');const ranked=REGISTRY.map(type=>({type,score:type.detect(intake)||0})).sort((a,b)=>b.score-a.score),best=ranked[0];if(!best||!best.score)throw Error('No upstream reader recognized '+name);const type=best.type;label.textContent=type.label;
 const settings=Object.fromEntries(descriptorsFor(type).map(d=>[d.key,d.default]));if(type.settingsUrl){const response=await fetch(type.settingsUrl,{signal:controller.signal});if(!response.ok)throw Error('Reader settings: HTTP '+response.status);const config=await response.json();for(const [key,value] of Object.entries(config.values||{}))if(Object.hasOwn(settings,key))settings[key]=value;}
 if(stale())return;
 const onCleanup=fn=>{if(stale()){fn();return()=>{};}cleanups.add(fn);return()=>cleanups.delete(fn);};let rendered;
 if(type.loadRenderer){const reader=await type.loadRenderer();if(stale())return;rendered=await reader.render(intake,{settings,signal:controller.signal,onCleanup,allowScripts:false,openIntake:inner=>open(inner.bytes,inner.filename,id),toast:message=>{if(!stale())label.textContent=String(message);}});}
 else if(type.capabilities?.rawView){const pre=document.createElement('pre');pre.textContent=intake.text;rendered={parentNode:pre};}
 else throw Error('This reader has no preview or text view');
 for(const key of ['archiveCleanup','revoke','destroy'])if(rendered[key])onCleanup(rendered[key]);if(stale())return;
 if(rendered.parentNode)host.append(rendered.parentNode);else{const preview=mountPreview(host,{bodyHtml:rendered.bodyHtml,fullDoc:rendered.fullDoc,allowScripts:!!rendered.ranScripts,extraHead:rendered.extraHead||'',theme:'light',style:previewStyle(settings),readerPrefs:rendered.readerPrefs,onOpen:rendered.openEntry?async path=>{const entry=await rendered.openEntry(path);if(!stale())await open(entry.bytes,entry.filename||path,id);}:undefined});onCleanup(()=>preview.destroy());}
 parent.postMessage({readerBridge:true,nonce,id,model:{typeId:type.id,label:type.label,summary:type.label}},location.origin);
}
window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||!event.data?.readerBridge||event.data.nonce!==nonce)return;const {bytes,name,id}=event.data;open(bytes,name,id).catch(error=>{if(error.name==='AbortError')return;label.textContent=error.message;parent.postMessage({readerBridge:true,nonce,id,error:error.message},location.origin);});});
window.addEventListener('pagehide',release);

parent.postMessage({readerBridge:true,nonce,ready:true},location.origin);
