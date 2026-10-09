import {parseGdsLayout} from './parser.ts';
self.onmessage=({data:{bytes}})=>{
 try{
  if(bytes.length>128*1024*1024)throw Error('GDSII input exceeds 128 MiB');
  if(bytes.length<6||bytes[0]!==0||bytes[1]!==6||bytes[2]!==0||bytes[3]!==2)throw Error('Invalid GDSII HEADER record');
  let offset=0,count=0,end=false;const unsupported=new Set();
  while(offset<bytes.length){if(offset+4>bytes.length)throw Error('Truncated GDSII record');const length=(bytes[offset]<<8)|bytes[offset+1],type=bytes[offset+2];if(length<4||length%2||offset+length>bytes.length)throw Error('Invalid GDSII record length');if(++count>250000)throw Error('GDSII exceeds 250000 records');if(type===16&&(length-4)%8)throw Error('Invalid GDSII XY coordinate record');if(type===4)end=true;if([26,27,28,45,46,48,20,21].includes(type))unsupported.add(type);offset+=length;}
  if(!end)throw Error('Missing GDSII ENDLIB record');
  const model=parseGdsLayout(bytes);if(!model)throw Error('No GDSII library was decoded');
  model.warnings.push('Cell references are shown as markers; reference arrays, rotations and magnification are not expanded.');
  if(unsupported.size)model.warnings.push('Unsupported geometry/transform records present: '+[...unsupported].join(', '));
  self.postMessage({model:{...model,summary:model.structureCount+' cells · '+model.elements.length+' elements'}});
 }catch(error){self.postMessage({error:error.message});}
};
