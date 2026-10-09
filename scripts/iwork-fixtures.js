// Authored parser contracts. No externally authored native binary payloads.
const JSZip=require('jszip'),{KeynoteArchives,TSPArchiveMessages}=require('keynote-archives'),snappy=require('snappyjs');
const varint=value=>{const bytes=[];do{const part=value&127;value=Math.floor(value/128);bytes.push(part|(value?128:0));}while(value);return Buffer.from(bytes);};
async function zip(name,bytes){const z=new JSZip();z.file(name,bytes);return z.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
async function fixtures(){
 const key=await zip('index.apxl','<presentation><slide-list><slide name="Probe"><body-placeholder><text-storage><text-body><p>iWork 09 Keynote fixture</p></text-body></text-storage></body-placeholder><notes>Original speaker note</notes></slide></slide-list></presentation>');
 const payload=KeynoteArchives[2001].toBinary(KeynoteArchives[2001].create({kind:0,text:['Original typed Pages fixture']}));
 const archive=TSPArchiveMessages.ArchiveInfo.toBinary(TSPArchiveMessages.ArchiveInfo.create({identifier:1n,messageInfos:[{type:2001,length:payload.length}]}));
 const compressed=snappy.compress(Buffer.concat([varint(archive.length),archive,payload]));const header=Buffer.from([0,compressed.length&255,(compressed.length>>>8)&255,(compressed.length>>>16)&255]);
 const pages=await zip('Index/Document.iwa',Buffer.concat([header,compressed]));return {key,pages};
}
module.exports={fixtures};
