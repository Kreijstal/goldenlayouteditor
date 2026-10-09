const { registerPlugin } = require('./plugins');
const { ImportedViewerPanel, element } = require('./imported-viewer-panel');
const { parseXMindWorkbook, renderXMindWorkbook, revokeObjectUrls } = require('./xmind-reader');
const styles = require('./xmind-style');
let ctx;
class XmindPanel extends ImportedViewerPanel {
    constructor(container, state) {
        super(container, state, ctx, {
            accept: '.xmind',
            async parse(bytes) {
                const workbook = await parseXMindWorkbook(bytes);
                return {...workbook,summary:workbook.sheets.length + ' sheets',release(){revokeObjectUrls(workbook.objectUrls);}};
            },
            render(model, host, bar) {
                host.classList.add('imported-xmind');
                host.style.cssText += ';overflow:hidden;--ofv-bg:#20242a;--ofv-surface:#2b3038;--ofv-surface-muted:#333a45;--ofv-border:#49505c;--ofv-text:#eee;--ofv-text-muted:#bdc4cf;--ofv-accent:#98b4ff;--ofv-accent-soft:#3a496c;--ofv-button-hover:#3a4250';
                element('style', styles, host);
                const zoom = element('span', undefined, bar);
                const view = renderXMindWorkbook(host, model.sheets, {options:{zoom:1},toolbar:{setZoom(value){zoom.textContent=Math.round((value || 1)*100)+'%';}}});
                const buttons = [];
                for (const [label, command] of [['−','zoom-out'],['+','zoom-in'],['100%','zoom-reset']]) {
                    const button = element('button',label,bar); button.onclick=()=>view.command(command); buttons.push(button);
                }
                view.resize();
                return {resize(){view.resize();},destroy(){view.destroy();zoom.remove();buttons.forEach(button=>button.remove());}};
            },
        });
    }
}
registerPlugin({id:'xmind',name:'XMind mind maps',components:{xmindViewer:XmindPanel},
    toolbarButtons:[{label:'XMind',title:'Open XMind mind map',menuLabel:'XMind mind map (.xmind)'}],init(context){ctx=context;} });
