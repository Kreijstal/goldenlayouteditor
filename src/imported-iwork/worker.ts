import {parseIworkDocument} from './parser.js';
self.onmessage=async({data:{bytes,name}})=>{
 try{if(bytes.byteLength>128*1024*1024)throw Error('iWork input exceeds 128 MiB');const type=name.toLowerCase().endsWith('.key')?'keynote':name.split('.').pop().toLowerCase();const model=await parseIworkDocument(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),type);self.postMessage({model});}
 catch(error){self.postMessage({error:error.message});}
};
