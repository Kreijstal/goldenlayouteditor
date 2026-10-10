import {Inflate} from 'pako';
import {inspectZipCentralDirectory} from '../imported-signature/structured/zipPreflight';
import {DEFAULT_SIGNATURE_CONTAINER_LIMITS} from '../imported-signature/structured/limits';
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const checksum=(bytes:Uint8Array)=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
self.onmessage=event=>{try{
 const bytes=new Uint8Array(event.data.bytes),kind=event.data.kind;
 const expected='application/vnd.oasis.opendocument.'+(kind==='odp'?'presentation':'text');
 const directory=inspectZipCentralDirectory(bytes,{...DEFAULT_SIGNATURE_CONTAINER_LIMITS,maxContainerBytes:32*1024*1024,maxTotalUncompressedBytes:32*1024*1024,maxEntryBytes:8*1024*1024});
 const view=new DataView(bytes.buffer),crcs:number[]=[];
 let end=bytes.length-22;while(view.getUint32(end,true)!==0x06054b50)end--;
 let central=view.getUint32(end+16,true);
 for(const entry of directory.entries){crcs.push(view.getUint32(central+16,true));central+=46+view.getUint16(central+28,true)+view.getUint16(central+30,true)+view.getUint16(central+32,true);}
 const read=(name:string,max:number)=>{
  const index=directory.entries.findIndex(entry=>entry.name===name),entry=directory.entries[index];if(!entry||entry.directory)throw Error('Missing ODF package entry: '+name);
  if(entry.uncompressedSize>max)throw Error('ODF entry exceeds limit: '+name);
  const offset=entry.localHeaderOffset+30+view.getUint16(entry.localHeaderOffset+26,true)+view.getUint16(entry.localHeaderOffset+28,true),packed=bytes.subarray(offset,offset+entry.compressedSize);
  let data:Uint8Array;
  if(entry.compressionMethod===0)data=packed.slice();else{
   const parts:Uint8Array[]=[];let size=0;const inflater=new Inflate({raw:true});inflater.onData=(part:Uint8Array)=>{size+=part.length;if(size>entry.uncompressedSize||size>max)throw Error('ODF entry exceeds declared expanded size');parts.push(part);};inflater.push(packed,true);if(inflater.err||!inflater.ended)throw Error('Invalid ODF compressed entry');data=new Uint8Array(size);let at=0;for(const part of parts){data.set(part,at);at+=part.length;}
  }
  if(data.length!==entry.uncompressedSize||checksum(data)!==crcs[index])throw Error('Invalid ODF entry length or CRC: '+name);
  return data;
 };
 if(new TextDecoder('utf-8',{fatal:true}).decode(read('mimetype',256))!==expected)throw Error('ODF package mimetype does not match extension');
 self.postMessage({xml:read('content.xml',4*1024*1024),manifest:read('META-INF/manifest.xml',4*1024*1024)});
 }catch(error){self.postMessage({error:(error instanceof Error?error.message:String(error)).replace('Unsafe ASiC ZIP','Unsafe ODF ZIP')});}};
