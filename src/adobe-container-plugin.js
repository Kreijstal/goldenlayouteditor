const {registerPlugin}=require('./plugins');
const {ImportedViewerPanel,element,details,card}=require('./imported-viewer-panel');
const {readWorker}=require('./worker-reader');
let ctx;
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v,null,2);
class AdobeContainerPanel extends ImportedViewerPanel{
 constructor(container,state){
  const controller=new AbortController();container.on('destroy',()=>controller.abort());
  super(container,state,ctx,{
   accept:'.indd,.indt,.xd,.icml,.idms,.inx,.ase,.aco',
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
