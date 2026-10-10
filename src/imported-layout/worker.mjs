import {parseGdsLayout} from './parser.ts';
self.onmessage=async({data:{bytes,name}})=>{
 try{
  if(/\.(oas|oasis)$/i.test(name||'')){
   if(bytes.length>64*1024*1024)throw Error('OASIS input exceeds 64 MiB');
   const {parseBinaryOasis}=await import('./oasis.ts');const layout=parseBinaryOasis(bytes);if(!layout)throw Error('Invalid OASIS START header');
   const elements=[...layout.shapes.map(s=>({kind:s.kind==='box'?'boundary':s.kind,structure:s.cell,layer:Number(s.layer),width:s.width,xy:s.points.map(([x,y])=>({x,y}))})),...layout.labels.map(s=>({kind:'text',structure:s.cell,layer:Number(s.layer),text:s.text,xy:[{x:s.x,y:s.y}]})),...layout.references.map(s=>({kind:'reference',structure:s.ownerCell,reference:s.cell,xy:[{x:s.x,y:s.y}]}))];
   const coordinates=elements.flatMap(e=>e.xy);if(coordinates.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw Error('Invalid OASIS coordinates');
   const bounds=coordinates.reduce((b,p)=>({minX:Math.min(b.minX,p.x),maxX:Math.max(b.maxX,p.x),minY:Math.min(b.minY,p.y),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
   self.postMessage({model:{libraryName:'OASIS '+layout.version,structures:layout.cells,databaseUnit:layout.unit?1e-6/layout.unit:undefined,elements,bounds,warnings:[...layout.warnings,'Partial OASIS geometry: rectangles, polygons, paths, labels and placement markers. References are not expanded; placement transforms are not rendered. Circles and trapezoids are unsupported. END validation signatures are not verified.'],summary:layout.cells.length+' cells · '+elements.length+' elements'}});return;
  }
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
