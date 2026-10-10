import {parseWordPerfectWithLibWpd} from './libwpd.js';
self.onmessage=async({data:{bytes}})=>{try{
 if(bytes.byteLength>128*1024*1024)throw Error('WordPerfect input exceeds 128 MiB');
 const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
 const model=await parseWordPerfectWithLibWpd(buffer,new URL('libwpd.mjs',self.location.href).href,new URL('libwpd.wasm',self.location.href).href);
 model.summary='WordPerfect '+model.generation+' · '+model.structuredParagraphs.length+' paragraphs';self.postMessage({model});
}catch(error){self.postMessage({error:error.message});}};
