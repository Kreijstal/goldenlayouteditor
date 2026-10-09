const { registerPlugin } = require('./plugins');
const { ImportedViewerPanel, element } = require('./imported-viewer-panel');
const { readFb2 } = require('./fb2-reader');
let ctx;
class Fb2Panel extends ImportedViewerPanel {
    constructor(container, state) {
        super(container, state, ctx, {
            accept: '.fb2', parse: readFb2,
            render(model, host, bar) {
                const size = element('select', undefined, bar); size.setAttribute('aria-label', 'Book text size');
                for (const value of [16,20,24,28]) size.add(new Option(value + ' px', value));
                size.value = '20';
                const frame = element('iframe', undefined, host);
                frame.title = model.title; frame.setAttribute('sandbox', '');
                frame.style.cssText = 'width:100%;height:100%;border:none;background:#f9f6ef';
                const show = () => {
                    frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">'
                        + '<style>body{max-width:50rem;margin:auto;padding:24px;color:#292724;background:#f9f6ef;font:' + size.value + 'px/1.7 Georgia,serif}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:6px}blockquote{border-left:3px solid #aaa;padding-left:16px}.fb2-empty{height:1em}.fb2-stanza{margin:1em 0}a{color:#235a9b}</style>' + model.html;
                };
                size.onchange = show; show();
                return {destroy(){size.remove();frame.remove();}};
            },
        });
    }
}
registerPlugin({id:'fb2',name:'FictionBook',components:{fb2Viewer:Fb2Panel},
    toolbarButtons:[{label:'FB2',title:'Open FictionBook',menuLabel:'FictionBook ebook (.fb2)'}],init(context){ctx=context;} });
