const {registerPlugin}=require('./plugins');
const {ImportedViewerPanel,element,details,card}=require('./imported-viewer-panel');
const {readWorker}=require('./worker-reader');
let ctx;
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v,null,2);
class AdobeContainerPanel extends ImportedViewerPanel{
 constructor(container,state){
  const controller=new AbortController();container.on('destroy',()=>controller.abort());
  super(container,state,ctx,{
   accept:'.indd,.indt,.xd,.icml,.idms,.inx,.ase,.aco,.abr,.csh,.pat,.grd,.asl',
   async parse(bytes){
    const file=state?.fileId && ctx.projectFiles[state.fileId];
    const model=await readWorker('adobe-viewer/worker.js',{bytes,name:file?.name||'local.indd'},controller.signal);
    return {...model,summary:model.status||model.fidelity||model.version||model.format};
   },
   render(model,host){return renderAdobe(model,host);}
  });
  this.adobeController=controller;
 }
 async show(bytes,name){
  this.options.parse=async bytes=>{
   const model=await readWorker('adobe-viewer/worker.js',{bytes,name},this.adobeController.signal);
   return {...model,summary:model.status||model.fidelity||model.version||model.format};
  };
  // init can call show before the constructor assignment, after readBytes yields.
  return super.show(bytes,name);
 }
}
function renderAdobe(model,host){
 const title=card(host,model.format.toUpperCase());
 if(['abr','csh','pat','grd','asl'].includes(model.format))return renderResources(model,host,title);
 if(model.colors && ['aco','ase'].includes(model.format)){
  details(title,'Version',model.version);details(title,'Colors',String(model.colors.length));
  for(const color of model.colors){const item=card(host,color.name||color.hex);const swatch=element('div',undefined,item);swatch.className='adobe-swatch';swatch.style.cssText='height:48px;background:'+color.hex;details(item,'Color',color.hex);details(item,'Model',color.model);details(item,'Components',color.componentText);details(item,'Group',color.groupPath.join(' / '));}
 }else if(['icml','idms','inx'].includes(model.format)){
  details(title,'Preview',model.fidelity);element('p','Extracted stories and layout structure; original page composition is not reconstructed.',title);
  for(const story of model.stories){const article=card(host,story.title||story.id);article.className='adobe-story';for(const paragraph of story.paragraphs){const p=element('p',undefined,article);for(const run of paragraph.runs){const span=element('span',run.text,p);if(run.pointSize)span.style.fontSize=run.pointSize+'pt';if(/bold/i.test(run.fontStyle||''))span.style.fontWeight='bold';if(/italic/i.test(run.fontStyle||''))span.style.fontStyle='italic';if(run.underline)span.style.textDecoration='underline';}}}
  if(model.items.length){const panel=card(host,'Layout items');element('pre',stringify(model.items),panel).style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';}
 }else{
  details(title,'Status',model.status||'Embedded preview / structure');element('p','Saved raster preview and container structure. Native layout reconstruction is not implemented.',title);
  if(model.preview){const url=URL.createObjectURL(new Blob([model.preview.bytes],{type:model.preview.mimeType}));const image=element('img',undefined,title);image.className='adobe-embedded-preview';image.alt='Saved embedded preview';image.src=url;image.style.cssText='max-width:100%;max-height:650px;object-fit:contain';model.previewUrl=url;}
  const metadata={...model};delete metadata.preview;delete metadata.previewUrl;delete metadata.xmp;
  element('pre',stringify(metadata),title).style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';
  if(model.xmp){const panel=card(host,'XMP metadata');element('pre',model.xmp,panel).style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';}
 }
 for(const warning of model.warnings||[])details(title,'Reader note',warning);
 return {destroy(){if(model.previewUrl)URL.revokeObjectURL(model.previewUrl);}};
}
registerPlugin({id:'adobe-container',name:'Adobe containers and palettes',components:{adobeContainerViewer:AdobeContainerPanel},toolbarButtons:[{label:'Adobe containers',title:'Open Adobe document or palette',menuLabel:'Adobe containers / palettes'}],init(context){ctx=context;}});

function renderResources(model,host,title){
 details(title,'Reader',model.engine);details(title,'Preview',model.fidelity);
 for(const note of model.limitations||[])details(title,'Reader note',note);
 const bitmap=(name,width,height,rgba)=>{const item=card(host,name);const canvas=element('canvas',undefined,item);canvas.className='adobe-resource-bitmap';canvas.width=width;canvas.height=height;canvas.style.cssText='max-width:100%;max-height:220px;object-fit:contain;background:#fff';canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);};
 for(const pattern of (model.patterns||[]).slice(0,64))bitmap(pattern.name||pattern.id,pattern.width,pattern.height,pattern.rgba);
 for(const sample of (model.samples||[]).slice(0,64)){const rgba=new Uint8Array(sample.alpha.length*4);sample.alpha.forEach((alpha,i)=>rgba.set([0,0,0,alpha],i*4));bitmap(sample.id,sample.width,sample.height,rgba);}
 for(const gradient of (model.gradients||[]).slice(0,64)){bitmap(gradient.name,gradient.previewRgba.length/4,1,gradient.previewRgba);details(host,'Definition',stringify(gradient.definition));}
 for(const shape of (model.shapes||[]).slice(0,64)){
  const item=card(host,shape.name);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('adobe-resource-shape');svg.setAttribute('viewBox',`0 0 ${shape.width} ${shape.height}`);svg.style.cssText='width:240px;height:180px;background:#fff';item.append(svg);
  for(const path of shape.paths){const node=document.createElementNS(svg.namespaceURI,'path');node.setAttribute('d',path.d);node.setAttribute('fill','#486db4');node.setAttribute('stroke','#172033');node.setAttribute('fill-rule',path.fillRule==='even-odd'?'evenodd':'nonzero');svg.append(node);}
  if(shape.hasUnsupportedBooleanComposition)details(item,'Reader note','Boolean path composition is incomplete');
 }
 for(const brush of (model.brushes||[]).slice(0,256))details(title,brush.name,stringify(brush.shape));
 for(const style of (model.styles||[]).slice(0,256))details(title,style.name,stringify(style));
 element('p','Preview shows up to 64 raster/vector resources and 256 descriptors. Layer effects are inspected as descriptors, without applying them to an image.',title);
 return {destroy(){}};
}
function isAdobeResourceFile(file){
 const match=/\.(csh|grd)$/i.exec(file.name||'');if(!match)return /\.(abr|pat|asl)$/i.test(file.name||'');
 const bytes=file.head||file.bytes;const head=bytes?new TextDecoder('latin1').decode(new Uint8Array(bytes).subarray(0,4)):(file.content||'').slice(0,4);
 return head ? head===(match[1].toLowerCase()==='csh'?'cush':'8BGR') : !file.content;
}
module.exports={isAdobeResourceFile};
