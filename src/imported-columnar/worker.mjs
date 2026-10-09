const MAX_BYTES=128*1024*1024,MAX_ROWS=100,MAX_COLUMNS=256;
function plain(value){
 if(value===null||value===undefined)return null;
 if(typeof value==='bigint')return String(value);
 if(value instanceof Date)return value.toISOString();
 if(ArrayBuffer.isView(value))return [...value].map(plain);
 if(value instanceof Map)return Object.fromEntries([...value].map(([k,v])=>[String(k),plain(v)]));
 if(Array.isArray(value))return value.map(plain);
 if(typeof value==='object')return Object.fromEntries(Object.entries(typeof value.toJSON==='function'?value.toJSON():value).map(([k,v])=>[k,plain(v)]));
 return value;
}
async function parquet(bytes){
 const {parquetMetadataAsync,parquetReadObjects}=await import('hyparquet');
 const {compressors}=await import('hyparquet-compressors');
 const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),file={byteLength:buffer.byteLength,slice:(a,b)=>buffer.slice(a,b)};
 const metadata=await parquetMetadataAsync(file);if(metadata.schema.length>MAX_COLUMNS*4)throw Error('Parquet schema exceeds column limit');
 const rows=await parquetReadObjects({file,metadata,compressors,rowEnd:MAX_ROWS});
 const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];if(columns.length>MAX_COLUMNS)throw Error('Parquet exceeds 256 columns');
 return{format:'Parquet',columns,totalRows:String(metadata.num_rows),rows:rows.map(plain),schema:plain(metadata.schema)};
}
async function arrow(bytes){
 const {tableFromIPC,compressionRegistry}=await import('apache-arrow');const {decompressZstd}=await import('hyparquet-compressors');const {default:lz4}=await import('lz4js');
 const bounded=decode=>({decode(bytes){const result=decode(bytes);if(result.length>MAX_BYTES*2)throw Error('Arrow decoded buffer exceeds 256 MiB');return result.slice();}});
 compressionRegistry.set(0,bounded(bytes=>new Uint8Array(lz4.decompress(bytes))));compressionRegistry.set(1,bounded(decompressZstd));
 const table=tableFromIPC(bytes);if(table.numCols>MAX_COLUMNS)throw Error('Arrow exceeds 256 columns');
 const rows=[];for(let i=0;i<Math.min(MAX_ROWS,table.numRows);i++)rows.push(plain(table.get(i)));
 return {format:'Arrow IPC / Feather v2',totalRows:String(table.numRows),columns:table.schema.fields.map(f=>f.name),schema:table.schema.fields.map(f=>({name:f.name,type:f.type.toString(),nullable:f.nullable})),rows};
}
async function avro(bytes){
 if(![79,98,106,1].every((value,i)=>bytes[i]===value))throw Error('Invalid Avro object-container signature');
 const {default:avro}=await import('avsc/etc/browser/avsc.js');const decoder=avro.createBlobDecoder(new Blob([bytes]));let schema='';const rows=[];let truncated=false;
 await new Promise((resolve,reject)=>{
  decoder.on('metadata',type=>schema=type.toString());decoder.on('error',reject);decoder.on('end',resolve);
  decoder.on('data',value=>{if(rows.length<MAX_ROWS)rows.push(plain(value));else{truncated=true;decoder.destroy();resolve();}});
 });
 const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];if(columns.length>MAX_COLUMNS)throw Error('Avro exceeds 256 columns');
 return {format:'Avro object container',columns,rows,schema,totalRows:truncated?'At least '+(MAX_ROWS+1):String(rows.length)};
}
self.onmessage=async({data:{bytes,name}})=>{
 try{if(bytes.byteLength>MAX_BYTES)throw Error('Columnar input exceeds 128 MiB');const ext=name.split('.').pop().toLowerCase();const model=await(ext==='parquet'?parquet(bytes):ext==='avro'?avro(bytes):arrow(bytes));self.postMessage({model:{...model,summary:model.format+' · '+model.totalRows+' rows'}});}
 catch(error){self.postMessage({error:error.message});}
};
