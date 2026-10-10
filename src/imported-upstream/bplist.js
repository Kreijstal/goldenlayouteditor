// Apple binary plist object/trailer format; exact large integers use tagged strings.
// Object markers follow CFBinaryPList.c and the MIT node-bplist-parser reader.
export function parseBinaryPlist(bytes){
 if(bytes.length<40||new TextDecoder().decode(bytes.slice(0,8))!=='bplist00')throw Error('Invalid binary property list');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),trailer=bytes.length-32,offsetWidth=bytes[trailer+6],refWidth=bytes[trailer+7];
 const uint=(offset,width,end=bytes.length)=>{if(width<1||width>16||offset<0||offset+width>end)throw Error('Invalid binary plist bounds');let value=0n;for(let i=0;i<width;i++)value=(value<<8n)|BigInt(bytes[offset+i]);return value;};
 const safe=value=>{if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Binary plist offset exceeds safe range');return Number(value);};
 const count=safe(uint(trailer+8,8)),top=safe(uint(trailer+16,8)),table=safe(uint(trailer+24,8));
 if(![1,2,4,8].includes(offsetWidth)||![1,2,4,8].includes(refWidth)||count>100000||!count||top>=count||table<8||table+count*offsetWidth>trailer)throw Error('Invalid binary plist trailer or object limit');
 const offsets=Array.from({length:count},(_,i)=>safe(uint(table+i*offsetWidth,offsetWidth,trailer)));if(offsets.some(o=>o<8||o>=table))throw Error('Invalid binary plist object offset');
 const memo=new Map(),visiting=new Set();
 function object(id,depth=0){
  if(!Number.isInteger(id)||id<0||id>=count||depth>128)throw Error('Binary plist reference/depth limit');if(memo.has(id))return memo.get(id);if(visiting.has(id))throw Error('Cyclic binary plist object references');visiting.add(id);
  const offset=offsets[id],marker=bytes[offset],type=marker>>4,info=marker&15;let position=offset+1,value;
  const length=()=>{if(info!==15)return info;const tag=bytes[position++];if((tag>>4)!==1||(tag&15)>3)throw Error('Invalid binary plist length');const width=2**(tag&15),n=safe(uint(position,width,table));position+=width;return n;};
  const slice=n=>{if(n>4*1024*1024||position+n>table)throw Error('Binary plist value exceeds bounds or 4 MiB limit');const data=bytes.slice(position,position+n);position+=n;return data;};
  const ref=at=>safe(uint(at,refWidth,table));
  if(type===0){if(info===0||info===15)value=null;else if(info===8)value=false;else if(info===9)value=true;else throw Error('Unsupported binary plist simple marker');}
  else if(type===1){const width=2**info;if(width>16)throw Error('Unsupported binary plist integer width');let n=uint(position,width,table);if(width>=8)n=BigInt.asIntN(width*8,n);value=n>=BigInt(Number.MIN_SAFE_INTEGER)&&n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):{type:'integer',value:n.toString()};}
  else if(type===2){const width=2**info;if(![4,8].includes(width)||position+width>table)throw Error('Unsupported binary plist real');const n=width===4?view.getFloat32(position,false):view.getFloat64(position,false);value=Number.isFinite(n)?n:{type:'real',value:String(n)};}
  else if(type===3){if(info!==3||position+8>table)throw Error('Invalid binary plist date');const date=new Date((view.getFloat64(position,false)+978307200)*1000);if(!Number.isFinite(date.getTime()))throw Error('Invalid binary plist timestamp');value={type:'date',value:date.toISOString()};}
  else if(type===4){const n=length();if(position+n>table)throw Error('Invalid binary plist data bounds');const preview=bytes.slice(position,position+Math.min(n,1024));value={type:'data',bytes:n,base64:btoa(String.fromCharCode(...preview)),truncated:n>1024};}
  else if([5,6,7].includes(type)){const n=length();value=new TextDecoder(type===6?'utf-16be':type===5?'ascii':'utf-8',{fatal:true}).decode(slice(n*(type===6?2:1)));}
  else if(type===8){value={type:'UID',value:uint(position,info+1,table).toString()};}
  else if([10,11,12].includes(type)){const n=length();if(n>100000||position+n*refWidth>table)throw Error('Binary plist collection limit');const items=Array.from({length:n},(_,i)=>object(ref(position+i*refWidth),depth+1));value=type===10?items:{type:type===11?'ordered-set':'set',values:items};}
  else if(type===13){const n=length();if(n>100000||position+n*refWidth*2>table)throw Error('Binary plist dictionary limit');value=Object.create(null);for(let i=0;i<n;i++){const key=object(ref(position+i*refWidth),depth+1);if(typeof key!=='string'||Object.hasOwn(value,key))throw Error('Invalid or duplicate binary plist key');value[key]=object(ref(position+(n+i)*refWidth),depth+1);}}
  else throw Error('Unsupported binary plist marker '+type);
  visiting.delete(id);memo.set(id,value);return value;
 }
 return object(top);
}
