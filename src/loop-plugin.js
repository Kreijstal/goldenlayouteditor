const {registerPlugin} = require('./plugins');
const {ImportedViewerPanel,element} = require('./imported-viewer-panel');
const {readLoop} = require('./loop-reader');
let ctx;
class LoopPanel extends ImportedViewerPanel {
    constructor(container,state) {
        super(container,state,ctx,{accept:'.loop',parse:readLoop,
            render(model,host) {
                element('p',model.warnings.join(' '),host).style.cssText='margin:16px;color:#c9b36b';
                const page=element('article',undefined,host); page.className='loop-document';
                page.style.cssText='margin:16px;padding:24px;background:white;color:#222;min-height:160px;font:16px/1.6 system-ui;white-space:pre-wrap;overflow-wrap:anywhere';
                if (!model.text.trim()) element('p','Empty paragraph component',page);
                for (const paragraph of model.paragraphs) {
                    const p=element('p',undefined,page);
                    for (const segment of paragraph) {
                        const span=element('span',segment.text,p);
                        if (segment.props.bold === true || segment.props.fontWeight === 'bold') span.style.fontWeight='bold';
                        if (segment.props.italic === true) span.style.fontStyle='italic';
                        if (segment.props.underline === true) span.style.textDecoration='underline';
                    }
                }
                const structure=element('details',undefined,host); structure.className='loop-structure'; structure.style.margin='16px';
                element('summary',`Snapshot structure · sequence ${model.sequenceNumber}`,structure);
                for (const entry of model.entries) {
                    const item=element('details',undefined,structure);
                    element('summary',`${entry.path} (${entry.size} bytes)`,item);
                    const pre=element('pre',JSON.stringify(JSON.parse(entry.text),null,2),item);
                    pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#171a1f';
                }
            }});
    }
}
registerPlugin({id:'loop',name:'Microsoft Loop snapshot',components:{loopViewer:LoopPanel},
    toolbarButtons:[{label:'Loop',title:'Open Microsoft Loop snapshot',menuLabel:'Microsoft Loop (.loop)'}],
    contextMenuItems:[{label:'Open Loop snapshot',canHandle:name=>/\.loop$/i.test(name || ''),
        action(fileId){const file=ctx.projectFiles[fileId];ctx.openEditorTab('loopViewer',{fileId},file.name+' [loop]','loop-'+fileId);}}],
    init(context){ctx=context;}});
