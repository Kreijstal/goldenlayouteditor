const {registerPlugin}=require('./plugins');
const {ImportedViewerPanel,element,details,card}=require('./imported-viewer-panel');
const {readWorker}=require('./worker-reader');
const renderIwork=require('./imported-iwork/viewer').default;
let ctx;
class IworkPanel extends ImportedViewerPanel{
 constructor(container,state){const active={controller:new AbortController()};container.on('destroy',()=>active.controller.abort());super(container,state,ctx,{accept:'.pages,.numbers,.key',parse:bytes=>readWorker('iwork-viewer/worker.js',{bytes,name:ctx.projectFiles[state?.fileId]?.name||'local.pages'},active.controller.signal),render(model,host,bar){
  const notes=card(host,model.title);details(notes,'Generation',model.generation);for(const note of [...model.diagnostics,...model.limits])details(notes,'Reader note',note);
  const target=element('div',undefined,host);target.style.cssText='height:650px;color:#111';const view=renderIwork(model,target);
  const buttons=[];for(const [label,method] of [['−','zoomOut'],['+','zoomIn'],['Reset','resetZoom']]){const button=element('button',label,bar);button.onclick=()=>target.iworkZoom[method]();buttons.push(button);}
  return{destroy(){view.unmount();buttons.forEach(b=>b.remove());}};
 }});this.active=active;}
 async show(bytes,name){this.active.controller.abort();this.active.controller=new AbortController();this.options.parse=async bytes=>{const model=await readWorker('iwork-viewer/worker.js',{bytes,name},this.active.controller.signal);return {...model,summary:model.scenes?.length+' scenes'};};return super.show(bytes,name);}
}
registerPlugin({id:'iwork',name:'Apple iWork',components:{iworkViewer:IworkPanel},toolbarButtons:[{label:'Apple iWork',title:'Open Pages, Numbers or Keynote',menuLabel:'Apple iWork'}],init(context){ctx=context;}});
function isIworkFile(file){
 if(!/\.(pages|numbers|key)$/i.test(file.name||''))return false;
 const bytes=file.head||file.bytes;const head=bytes?new TextDecoder('latin1').decode(new Uint8Array(bytes).subarray(0,2)):(file.content||'').slice(0,2);
 return head?head==='PK':!file.content;
}
module.exports={isIworkFile};
