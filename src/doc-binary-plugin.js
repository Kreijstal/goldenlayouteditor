const {registerPlugin}=require('./plugins');const {ImportedViewerPanel,element,details,card}=require('./imported-viewer-panel');const {readWorker}=require('./worker-reader');const DOMPurify=require('dompurify');let ctx;
class DocPanel extends ImportedViewerPanel{
 constructor(container,state){const active={controller:new AbortController()};container.on('destroy',()=>active.controller.abort());super(container,state,ctx,{accept:'.doc,.dot',parse:bytes=>readWorker('doc-viewer/worker.js',{bytes},active.controller.signal),render(model,host,bar){
  const notes=card(host,'Word binary document');for(const warning of model.warnings||[])details(notes,'Reader note',typeof warning==='string'?warning:warning.message||JSON.stringify(warning));
  const select=element('select',undefined,bar);select.setAttribute('aria-label','Tracked changes');for(const [value,label] of [['all','Show changes'],['final','Accept changes'],['original','Original text']]){const option=element('option',label,select);option.value=value;}
  const frame=element('iframe',undefined,host);frame.className='msdoc-frame';frame.title='Word document';frame.setAttribute('sandbox','allow-same-origin');frame.style.cssText='width:100%;height:750px;border:0;background:white';
  const render=()=>{const view=model.views[select.value];const clean=DOMPurify.sanitize(view.html,{ADD_TAGS:['svg','path'],FORBID_TAGS:['script','iframe','object','embed','form','input','button','link','meta'],FORBID_ATTR:['srcset']});frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>body{margin:24px;color:#111;background:white}'+view.css+'</style>'+clean;};select.onchange=render;render();
  return {destroy(){select.remove();frame.remove();}};
 }});this.active=active;}
 async show(bytes,name){this.active.controller.abort();this.active.controller=new AbortController();this.options.parse=bytes=>readWorker('doc-viewer/worker.js',{bytes,name},this.active.controller.signal);return super.show(bytes,name);}
}
function isWordBinaryFile(file){
 if(!/\.(doc|dot)$/i.test(file.name||''))return false;
 const bytes=file.head||file.bytes;if(bytes){const b=new Uint8Array(bytes);return b.length>=4&&b[0]===0xd0&&b[1]===0xcf&&b[2]===0x11&&b[3]===0xe0;}
 const content=file.content||'';return content?content.charCodeAt(0)===0xd0&&!/^\s*(?:digraph|graph)\b/.test(content):true;
}
registerPlugin({id:'doc-binary',name:'Word binary documents',components:{wordBinaryViewer:DocPanel},toolbarButtons:[{label:'Word binary',title:'Open Word binary document',menuLabel:'Word binary documents'}],init(context){ctx=context;}});module.exports={isWordBinaryFile};
