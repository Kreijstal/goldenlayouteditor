import {parseMsDoc} from './msdoc/parser.js';
import {renderMsDoc} from './render/html.js';
self.onmessage=({data:{bytes}})=>{try{
 if(bytes.byteLength>128*1024*1024)throw Error('Word input exceeds 128 MiB');
 const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),parsed=parseMsDoc(buffer);
 const views=Object.fromEntries(['all','final','original'].map(reviewMode=>[reviewMode,renderMsDoc(parsed,{reviewMode})]));
 self.postMessage({model:{views,summary:'Word binary document',warnings:parsed.warnings}});
}catch(error){self.postMessage({error:error.message});}};
