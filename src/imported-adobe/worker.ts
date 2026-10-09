// Apache-2.0 Flyfish readers hosted in a dedicated local worker.
import {readInDesignContainer} from './indesignContainer.js';
import {readXdContainer} from './xdContainer.js';
import {parseInDesignExchange} from './indesignExchangeParser.js';
import {parseAdobePalette} from './designResourceParser.js';
self.onmessage=async({data:{bytes,name}})=>{
 try{
  const format=name.split('.').pop().toLowerCase(),buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  let model;
  if(format==='indd'||format==='indt')model=readInDesignContainer(buffer,format);
  else if(format==='xd')model=await readXdContainer(buffer);
  else if(format==='icml'||format==='idms'||format==='inx')model=parseInDesignExchange(buffer,format);
  else if(format==='abr'||format==='csh'){
   const {parseAdobeBrushResource}=await import('./adobeBrushResourceParser.js');const {DEFAULT_PHOTOSHOP_PARSE_LIMITS}=await import('./limits.js');model=parseAdobeBrushResource(buffer,format,DEFAULT_PHOTOSHOP_PARSE_LIMITS);
  }
  else if(format==='pat'||format==='grd'||format==='asl'){
   const {parseAdobePresetResource}=await import('./adobePresetParser.js');const {DEFAULT_PHOTOSHOP_PARSE_LIMITS}=await import('./limits.js');model=parseAdobePresetResource(buffer,format,DEFAULT_PHOTOSHOP_PARSE_LIMITS);
  }
  else if(format==='aco'||format==='ase')model=parseAdobePalette(buffer,format,{maxFileBytes:64*1024*1024,maxResourceItems:10000,maxResourceNameCodeUnits:8192});
  else throw new Error('Unsupported Adobe container format');
  self.postMessage({model});
 }catch(error){self.postMessage({error:error.message});}
};
