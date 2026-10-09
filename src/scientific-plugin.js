const {registerPlugin}=require('./plugins');
const {resolveAssetUrl}=require('./lazy-viewers');
const {readBytes,element,details}=require('./imported-viewer-panel');
let ctx;
class ScientificPanel{
 constructor(container,state){
  this.root=container.element;this.destroyed=false;this.sequence=0;
  this.root.style.cssText+=';height:100%;display:flex;flex-direction:column;overflow:hidden;background:#20242a;color:#eee;font:14px system-ui';
  const bar=element('div');bar.style.cssText='display:flex;gap:10px;padding:10px';
  const open=element('button','Open scientific data',bar);const input=element('input',undefined,bar);input.type='file';input.accept='.h5,.hdf,.hdf5,.he5,.nc,.nc4,.netcdf,.npy,.npz';input.hidden=true;
  this.search=element('input',undefined,bar);this.search.type='search';this.search.placeholder='Find dataset';this.search.setAttribute('aria-label','Find dataset');this.search.oninput=()=>this.filter();
  this.label=element('span','Choose a scientific data file',bar);
  this.host=element('div');this.host.style.cssText='flex:1;min-height:0;display:flex;overflow:hidden';this.root.replaceChildren(bar,this.host);
  open.onclick=()=>input.click();input.onchange=async()=>{const file=input.files[0];if(file)await this.show(new Uint8Array(await file.arrayBuffer()),file.name);};
  container.on('destroy',()=>{this.destroyed=true;this.sequence++;this.cancel();this.host.replaceChildren();});
  this.ready=this.init(state||{});
 }
 async init(state){if(state.fileId){const file=ctx.projectFiles[state.fileId];if(!file)throw new Error('File no longer exists');await this.show(await readBytes(file,ctx),file.name);}}
 cancel(){if(this.worker){this.worker.terminate();this.worker=null;this.pending?.(null);this.pending=null;}}
 async show(bytes,name){
  if(this.destroyed)return;const sequence=++this.sequence;this.cancel();this.host.replaceChildren();this.label.textContent=name+' · reading…';
  const worker=new Worker(resolveAssetUrl('scientific-viewer/scientific-worker.js'),{type:'module'});this.worker=worker;
  let model;
  try{model=await new Promise((resolve,reject)=>{
   this.pending=resolve;
   worker.onmessage=({data})=>data.error?reject(new Error(data.error)):resolve(data.model);
   worker.onerror=event=>reject(new Error(event.message));
   worker.postMessage({bytes,name});
  });}finally{worker.terminate();if(this.worker===worker){this.worker=null;this.pending=null;}}
  if(!model||this.destroyed||sequence!==this.sequence)return;
  this.model=model;this.label.textContent=name+' · '+model.format+' · '+model.nodes.length+' entries';this.render(model);
 }
 render(model){
  this.list=element('div',undefined,this.host);this.list.className='scientific-datasets';this.list.style.cssText='width:32%;min-width:160px;overflow:auto;border-right:1px solid #49505c;padding:10px';
  this.detail=element('div',undefined,this.host);this.detail.className='scientific-detail';this.detail.style.cssText='flex:1;overflow:auto;padding:15px';
  for(const node of model.nodes){const button=element('button',node.path,this.list);button.style.cssText='display:block;text-align:left;width:100%;padding:10px;margin-bottom:5px;overflow-wrap:anywhere';button.onclick=()=>this.select(node);}
  if(model.nodes.length)this.select(model.nodes[0]);else element('p','No groups or datasets',this.detail);
  this.filter();
 }
 filter(){if(this.list)for(const button of this.list.children){button.hidden=!button.textContent.toLowerCase().includes(this.search.value.toLowerCase());button.style.display=button.hidden?'none':'block';}}
 select(node){
  this.detail.replaceChildren();element('h2',node.path,this.detail);details(this.detail,'Kind',node.kind);details(this.detail,'Shape',node.shape?JSON.stringify(node.shape):'');details(this.detail,'Type',node.dtype);details(this.detail,'Preview',node.notice);
  for(const [label,attrs] of [['File attributes',this.model.attributes],['Entry attributes',node.attributes||[]]]){if(attrs.length){element('h3',label,this.detail);for(const attr of attrs)details(this.detail,attr.name,attr.value);}}
  if(node.values?.length){element('h3','Stored values',this.detail);const table=element('table',undefined,this.detail);table.className='scientific-values';table.style.cssText='border-collapse:collapse;width:100%';const head=element('tr',undefined,table);element('th','Sample index',head);element('th','Value',head);
   node.values.forEach((value,index)=>{const row=element('tr',undefined,table);element('td',String(index),row);element('td',value,row);row.style.cssText='border-top:1px solid #49505c;white-space:pre-wrap;overflow-wrap:anywhere';});
  }
 }
}
registerPlugin({id:'scientific-data',name:'Scientific data',components:{scientificViewer:ScientificPanel},toolbarButtons:[{label:'Scientific data',title:'Open scientific dataset',menuLabel:'Scientific data (HDF5 / NetCDF / NumPy)'}],init(context){ctx=context;}});
