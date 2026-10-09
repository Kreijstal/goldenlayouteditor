const {registerPlugin} = require('./plugins');
const {ImportedViewerPanel,element} = require('./imported-viewer-panel');
const renderBundle = require('./imported-bundle/viewer').default;
let ctx;
class BundlePanel extends ImportedViewerPanel {
 constructor(container,state){
  super(container,state,ctx,{
   accept:'.bundle',
   async parse(bytes){
    const target=element('div');target.style.cssText='height:100%;min-height:0';
    const view=await renderBundle(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),target,'bundle',{options:{}});
    return {target,summary:'Git refs, history and file tree',release(){view.unmount();}};
   },
   render(model,host,bar){
    host.style.overflow='auto';host.append(model.target);
    const root=model.target.querySelector('.git-bundle-viewer');
    const buttons=[];
    for(const [label,command] of [['−','zoomOut'],['+','zoomIn'],['100%','resetZoom']]){
     const button=element('button',label,bar);button.onclick=()=>root.bundleZoom[command]();buttons.push(button);
    }
    return {destroy(){buttons.forEach(b=>b.remove());}};
   }
  });
 }
}
registerPlugin({id:'git-bundle',name:'Git bundle',components:{bundleViewer:BundlePanel},toolbarButtons:[{label:'Git bundle',title:'Open Git bundle',menuLabel:'Git bundle (.bundle)'}],init(context){ctx=context;}});
