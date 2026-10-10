import {Inflate} from 'pako';
import {parse} from 'plantuml-parser/dist/plantuml';
self.onmessage=event=>{try{
 const {source,kind}=event.data;if(typeof source!=='string'||source.length>2*1024*1024)throw Error('Diagram source exceeds 2 MiB');
 if(kind==='compressed'){
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(source)||source.length%4)throw Error('Invalid Draw.io Base64');const bytes=Uint8Array.from(atob(source),c=>c.charCodeAt(0));const inflater=new Inflate({raw:true});let size=0;const chunks:Uint8Array[]=[];inflater.onData=chunk=>{size+=chunk.length;if(size>4*1024*1024)throw Error('Draw.io expansion exceeds 4 MiB');chunks.push(chunk);};inflater.push(bytes,true);if(inflater.err||!inflater.ended)throw Error('Invalid Draw.io raw-deflate data');const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}self.postMessage({xml:decodeURIComponent(new TextDecoder('utf-8',{fatal:true}).decode(out))});return;
 }
 if(kind!=='plantuml')throw Error('Unknown diagram parser');if(source.length>65536)throw Error('PlantUML source exceeds 64 KiB');if(!/^\s*@startuml\b/.test(source)||!/@enduml\s*$/.test(source))throw Error('PlantUML requires @startuml and @enduml');if(/^\s*!/m.test(source))throw Error('PlantUML preprocessor directives are unsupported');const diagrams=parse(source);if(diagrams.length!==1||!diagrams[0].elements.length||diagrams[0].elements.length>250)throw Error('PlantUML requires one diagram with 1–250 recognized elements');self.postMessage({diagram:diagrams[0]});
 }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
