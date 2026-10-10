// Native MMPZ uses Qt qCompress: big-endian expanded size plus zlib data.
// LMMS source: src/core/DataFile.cpp, writeFile()/qCompress(xml.toUtf8()).
export async function decodeMmpz(bytes,signal){
 if(bytes.length<6)throw Error('Truncated Qt-compressed LMMS project');
 const expected=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,false);
 if(!expected||expected>64*1024*1024)throw Error('LMMS expanded size exceeds 64 MiB');
 const reader=new Blob([bytes.slice(4)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();const chunks=[];let total=0;
 const abort=()=>reader.cancel(signal.reason);signal.addEventListener('abort',abort,{once:true});
 try{while(true){if(signal.aborted)throw new DOMException('Cancelled','AbortError');const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>expected)throw Error('LMMS expanded size differs from Qt header');chunks.push(value);}if(total!==expected)throw Error('LMMS expanded size differs from Qt header');const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;}finally{signal.removeEventListener('abort',abort);await reader.cancel();reader.releaseLock();}
}
