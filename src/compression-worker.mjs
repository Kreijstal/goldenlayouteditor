const LIMIT=64*1024*1024;
async function collect(stream){
 const reader=stream.getReader(),chunks=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>LIMIT)throw new Error('Expanded stream exceeds 64 MiB');chunks.push(value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
self.onmessage=async function handle({data:{bytes,name}}){
 // The catch transfers decoder errors to the host. Format selection is explicit.
 try{
  let result;
  if(/\.(bz2|bzip2)$/i.test(name)){const {default:Bunzip}=await import('seek-bzip');result=new Uint8Array(Bunzip.decode(bytes));}
  else if(/\.xz$/i.test(name)){const {default:{XzReadableStream}}=await import('xz-decompress');result=await collect(new XzReadableStream(new Blob([bytes]).stream()));}
  else if(/\.gzip$/i.test(name))result=await collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  else if(/\.lzma$/i.test(name)){
   const {default:module}=await import('lzma/src/lzma_worker.js');self.onmessage=handle;
   const value=await new Promise((resolve,reject)=>module.LZMA_WORKER.decompress(bytes,(result,error)=>error?reject(error):resolve(result)));
   result=typeof value==='string'?new TextEncoder().encode(value):Uint8Array.from(value);
  }else throw new Error('Unsupported compressed stream');
  if(result.length>LIMIT)throw new Error('Expanded stream exceeds 64 MiB');self.postMessage({bytes:result},[result.buffer]);
 }catch(error){self.postMessage({error:error.message});}
};
