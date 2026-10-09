const FILE_LIMIT = 64 * 1024 * 1024;
const NODE_LIMIT = 500;
const SAMPLE_LIMIT = 100;
const json = value => JSON.stringify(value, (_,v) => typeof v === 'bigint' ? v.toString() : ArrayBuffer.isView(v) ? [...v] : v);
function sample(value){
 if(value === null || value === undefined)return [];
 if(Array.isArray(value))return value.flat(Infinity).slice(0,SAMPLE_LIMIT).map(v=>typeof v==='object'?json(v):String(v));
 if(ArrayBuffer.isView(value))return Array.from(value.subarray(0,SAMPLE_LIMIT),String);
 return [typeof value==='object'?json(value):String(value)];
}
async function hdf(bytes){
 const h5=await import('h5wasm');await h5.ready;
 const filename='/preview.h5';h5.FS.writeFile(filename,bytes);
 let file;
 const nodes=[];
 const attrs=entity=>Object.entries(entity.attrs).map(([name,attr])=>{
  const m=attr.metadata;
  return {name,value:m.size*m.total_size>65536?'Attribute exceeds 64 KiB preview limit':json(attr.value)};
 });
 try{
  file=new h5.File(filename,'r');
  function walk(group,depth){
   if(depth>24)throw new Error('HDF5 group depth exceeds 24');
   for(const name of group.keys()){
    if(nodes.length>=NODE_LIMIT)throw new Error('HDF5 hierarchy exceeds 500 nodes');
    const entity=group.get(name);
    if(entity instanceof h5.Group){nodes.push({path:entity.path,kind:'Group',attributes:attrs(entity)});walk(entity,depth+1);}
    else if(entity instanceof h5.Dataset){
     const shape=entity.shape;const meta=entity.metadata;
     let values=[],notice='';
     if(meta.vlen || meta.size>65536)notice='Variable-length or oversized elements: metadata preview only';
     else if(!shape)notice='Null dataspace';
     else if(shape.some(n=>n===0))notice='Empty dataset';
     else{
      const ranges=shape.map((n,i)=>[0,Math.min(n,i===shape.length-1?SAMPLE_LIMIT:1)]);
      values=sample(shape.length?entity.slice(ranges):entity.value);
      notice='First row/line, up to 100 elements; stored values';
     }
     nodes.push({path:entity.path,kind:'Dataset',shape,dtype:json(entity.dtype),attributes:attrs(entity),values,notice});
    }else nodes.push({path:group.path+'/'+name,kind:'Link or named datatype',notice:'No dataset values'});
   }
  }
  const attributes=attrs(file);walk(file,0);return {format:'HDF5 / NetCDF-4',attributes,nodes};
 }finally{file?.close();h5.FS.unlink(filename);}
}
async function netcdf(bytes){
 const {NetCDFReader}=await import('netcdfjs');const reader=new NetCDFReader(bytes);
 const nodes=reader.variables.map(variable=>{
  const dimensions=variable.dimensions.map(i=>reader.dimensions[i]);
  const shape=dimensions.map(d=>d.size || reader.recordDimension.length);
  const count=shape.reduce((a,b)=>a*b,1);
  const read=count<=1000000;
  return {path:variable.name,kind:'Variable',shape,dtype:variable.type,attributes:variable.attributes.map(a=>({name:a.name,value:json(a.value)})),values:read?sample(reader.getDataVariable(variable.name)):[],notice:read?'First 100 stored values':'More than 1,000,000 elements: metadata preview only'};
 });
 return {format:'NetCDF '+reader.version,attributes:reader.globalAttributes.map(a=>({name:a.name,value:json(a.value)})),nodes};
}
async function numpy(bytes,name){
 const {load}=await import('npyjs');
 async function read(bytes,path){
  // npyjs 1.0.4 uses native typed arrays for numeric payloads. Normalize
  // big-endian elements before parsing, retaining the original dtype for display.
  const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const view=new DataView(buffer),normalized=new Uint8Array(buffer);
  if(bytes.byteLength<10)throw new Error('Truncated NumPy header');
  const version=view.getUint8(6);
  if(version<1 || version>3)throw new Error('Unsupported NumPy version');
  const headerOffset=version===1?10:12;
  const headerLength=version===1?view.getUint16(8,true):view.getUint32(8,true);
  if(headerOffset+headerLength>bytes.length)throw new Error('Truncated NumPy dictionary');
  const header=new TextDecoder().decode(normalized.subarray(headerOffset,headerOffset+headerLength));
  const match=/'descr'\s*:\s*'([^']+)'/.exec(header);
  if(!match || !/^[<>=|][biuf](1|2|4|8)$/.test(match[1]))throw new Error('Only scalar numeric/boolean NumPy dtypes are supported');
  const originalDtype=match[1],size=Number(originalDtype.slice(2)),dataOffset=headerOffset+headerLength;
  if((buffer.byteLength-dataOffset)%size)throw new Error('Truncated NumPy element');
  if(originalDtype[0]==='>' && size>1){
   for(let offset=dataOffset;offset<normalized.length;offset+=size)normalized.subarray(offset,offset+size).reverse();
   normalized[headerOffset+match.index+match[0].indexOf(originalDtype)]='<'.charCodeAt(0);
  }
  const array=await load(buffer);
  if(!array.shape.every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('Invalid NumPy array shape');
  const count=array.shape.reduce((a,b)=>a*b,1),channels=/c\d+$/.test(array.dtype)?2:1;
  if(!Number.isSafeInteger(count)||array.data.length!==count*channels)throw new Error('NumPy payload does not match its shape');
  return {path,kind:'Array',shape:array.shape,dtype:originalDtype,attributes:[],values:sample(array.data),notice:(array.fortranOrder?'Fortran':'C')+' storage order; first 100 stored values'+(channels===2?'; alternating real/imaginary components':'')};
 }
 let nodes;
 if(/\.npz$/i.test(name)){
  const {default:JSZip}=await import('jszip');const archive=await JSZip.loadAsync(bytes);const entries=Object.values(archive.files).filter(e=>!e.dir && /\.npy$/i.test(e.name));
  if(entries.length>NODE_LIMIT)throw new Error('NumPy archive exceeds 500 arrays');
  if(!entries.length)throw new Error('No NumPy arrays in archive');
  const total=entries.reduce((n,e)=>n+e._data.uncompressedSize,0);
  if(!Number.isSafeInteger(total)||total>FILE_LIMIT)throw new Error('NumPy archive exceeds 64 MiB expanded limit');
  nodes=[];for(const entry of entries)nodes.push(await read(await entry.async('uint8array'),entry.name));
 }else nodes=[await read(bytes,name)];
 return {format:'NumPy',attributes:[],nodes};
}
self.onmessage=async({data:{bytes,name}})=>{
 // This catch transports worker errors to the UI; parsing never falls back.
 try{
  if(bytes.byteLength>FILE_LIMIT)throw new Error('Scientific preview limit is 64 MiB');
  const magic=new TextDecoder('latin1').decode(bytes.subarray(0,8));
  let model;
  if(/\.(npy|npz)$/i.test(name))model=await numpy(bytes,name);
  else if(magic.startsWith('CDF'))model=await netcdf(bytes);
  else model=await hdf(bytes);
  self.postMessage({model});
 }catch(error){self.postMessage({error:error.message});}
};
