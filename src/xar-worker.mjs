import {SaxesParser} from 'saxes';
import {inflate} from 'pako';
let bytes,heap,entries=[];
const direct=(node,name)=>node.children.filter(n=>n.tag===name);
const value=(node,name)=>direct(node,name)[0]?.text;
const integer=text=>{if(!/^\d+$/.test(text))throw new Error('Invalid XAR numeric field');const n=Number(text);if(!Number.isSafeInteger(n))throw new Error('XAR offset exceeds safe range');return n;};
function open(input){
 bytes=input;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(bytes.length<28||new TextDecoder().decode(bytes.subarray(0,4))!=='xar!')throw new Error('Invalid XAR header');
 const size=view.getUint16(4,false),version=view.getUint16(6,false),compressed=Number(view.getBigUint64(8,false)),expanded=Number(view.getBigUint64(16,false));
 if(version!==1||size<28||!Number.isSafeInteger(compressed)||expanded>8*1024*1024||size+compressed>bytes.length)throw new Error('Unsupported or oversized XAR TOC');
 const toc=inflate(bytes.subarray(size,size+compressed));if(toc.length!==expanded)throw new Error('XAR TOC size mismatch');heap=size+compressed;
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(toc),root={children:[]};const stack=[root];const parser=new SaxesParser();
 parser.on('opentag',tag=>{if(stack.length>26)throw new Error('XAR XML exceeds 26 levels');const node={tag:tag.name,attributes:tag.attributes,text:'',children:[]};stack.at(-1).children.push(node);stack.push(node);});parser.on('text',text=>stack.at(-1).text+=text);parser.on('closetag',()=>stack.pop());parser.on('error',error=>{throw error;});parser.write(xml).close();
 const tocNode=direct(direct(root,'xar')[0],'toc')[0];if(!tocNode)throw new Error('Missing XAR TOC');entries=[];
 function walk(parent,prefix=''){
  for(const file of direct(parent,'file')){
   if(entries.length>=10000)throw new Error('XAR exceeds 10,000 entries');
   const name=value(file,'name');if(!name)throw new Error('Missing XAR file name');const path=prefix+name;const type=value(file,'type');
   if(type==='directory'){entries.push({path,type:'DIR',size:0});walk(file,path+'/');}
   else if(type==='file'){
    const data=direct(file,'data')[0];if(!data)throw new Error('Missing XAR data descriptor');
    const offset=integer(value(data,'offset')),length=integer(value(data,'length')),size=integer(value(data,'size'));
    if(heap+offset+length>bytes.length)throw new Error('XAR entry outside file bounds');
    entries.push({path,type:'FILE',size,fileName:name,offset,length,encoding:direct(data,'encoding')[0]?.attributes.style});
   }else entries.push({path,type:'LINK',size:0});
  }
 }
 walk(tocNode);return entries;
}
self.onmessage=({data})=>{
 try{
  if(data.op==='open')self.postMessage({entries:open(data.bytes)});
  else{
   const entry=entries.find(e=>e.path===data.path);if(!entry||entry.type!=='FILE')throw new Error('No XAR file selected');if(entry.size>64*1024*1024)throw new Error('XAR entry exceeds 64 MiB');
   let output=bytes.slice(heap+entry.offset,heap+entry.offset+entry.length);
   if(entry.encoding==='application/x-gzip')output=inflate(output);
   else if(entry.encoding!=='application/octet-stream')throw new Error('Unsupported XAR encoding: '+entry.encoding);
   if(output.length!==entry.size)throw new Error('XAR entry size mismatch');self.postMessage({bytes:output},[output.buffer]);
  }
 }catch(error){self.postMessage({error:error.message});}
};
