const Comlink=require('comlink');
const {resolveAssetUrl}=require('./lazy-viewers');
class ArchiveSession{
 static validate(bytes,name){
  const head=new TextDecoder('latin1').decode(bytes.subarray(0,8));
  let valid=true;
  if(/\.(7z|cb7)$/i.test(name))valid=[0x37,0x7a,0xbc,0xaf,0x27,0x1c].every((n,i)=>bytes[i]===n);
  else if(/\.(rar|cbr)$/i.test(name))valid=head.startsWith('Rar!\x1a\x07');
  else if(/\.cab$/i.test(name))valid=head.startsWith('MSCF');
  else if(/\.(ar|deb|udeb)$/i.test(name))valid=head==='!<arch>\n';
  else if(/\.(rpm|srpm)$/i.test(name))valid=[0xed,0xab,0xee,0xdb].every((n,i)=>bytes[i]===n);
  else if(/\.(zipx|aab|mcpack|mctemplate|mcworld)$/i.test(name))valid=head.startsWith('PK');
  if(!valid)throw new Error('Archive signature does not match '+name);
 }
 constructor(workerPath='archive-viewer/worker-bundle.js'){
  this.worker=new Worker(resolveAssetUrl(workerPath),{type:'module'});this.closed=false;
  this.failure=new Promise((_,reject)=>this.fail=reject);this.worker.onerror=event=>this.fail(new Error(event.message));
 }
 async run(job){
  if(this.closed)throw new Error('Archive session closed');let timeout;
  try{return await Promise.race([job(),this.failure,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('Archive operation exceeded 60 seconds')),60000))]);}
  finally{clearTimeout(timeout);}
 }
 async open(file){
  await this.run(async()=>{
   ArchiveSession.validate(new Uint8Array(await file.arrayBuffer()),file.name);
   const Client=Comlink.wrap(this.worker);let ready;const clientReady=new Promise(resolve=>ready=resolve);
   this.client=await new Client(Comlink.proxy(ready));await clientReady;
   let opened;const fileReady=new Promise(resolve=>opened=resolve);
   await this.client.open(file,Comlink.proxy(opened));await fileReady;
  });
  const entries=await this.run(()=>this.client.listFiles());
  if(entries.length>10000)throw new Error('Archive exceeds 10,000 entries');
  this.entries=entries;return entries;
 }
 async extract(entry){
  if(entry.type!=='FILE')throw new Error('Select a regular file');
  if(entry.size>64*1024*1024)throw new Error('Entry exceeds 64 MiB preview limit');
  const result=await this.run(()=>this.client.extractSingleFile(entry.path));
  if(!result?.fileData)throw new Error('No file data returned for '+entry.path);
  return new Uint8Array(result.fileData);
 }
 close(){if(this.closed)return;this.closed=true;this.worker.terminate();this.fail(new DOMException('Archive closed','AbortError'));}
}
class CompressionSession extends ArchiveSession{
 constructor(){super('archive-viewer/compression-worker.js');}
 async open(file){
  const bytes=new Uint8Array(await file.arrayBuffer());
  this.bytes=await this.run(()=>new Promise((resolve,reject)=>{
   this.worker.onmessage=({data})=>data.error?reject(new Error(data.error)):resolve(data.bytes);
   this.worker.postMessage({bytes,name:file.name},[bytes.buffer]);
  }));this.worker.terminate();
  const name=file.name.replace(/\.(bz2|bzip2|xz|lzma|gzip)$/i,'')||'data';
  this.entries=[{type:'FILE',path:name,fileName:name,size:this.bytes.length}];return this.entries;
 }
 async extract(){if(this.closed)throw new Error('Compressed stream closed');return this.bytes;}
}
class XarSession extends ArchiveSession{
 constructor(){super('archive-viewer/xar-worker.js');}
 async message(data){return this.run(()=>new Promise((resolve,reject)=>{this.worker.onmessage=({data})=>data.error?reject(new Error(data.error)):resolve(data);this.worker.postMessage(data);}));}
 async open(file){const bytes=new Uint8Array(await file.arrayBuffer());this.entries=(await this.message({op:'open',bytes})).entries;return this.entries;}
 async extract(entry){return (await this.message({op:'extract',path:entry.path})).bytes;}
}
module.exports={ArchiveSession,CompressionSession,XarSession};
