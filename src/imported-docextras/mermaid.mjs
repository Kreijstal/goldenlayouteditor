import mermaid from 'mermaid';
import {assertFileViewerMermaidSourceHasNoExternalResources} from './svg-resources.ts';
export async function renderDiagram(source){
 if(source.length>65536)throw Error('Mermaid source exceeds 64 KiB');
 if(/%%\{|^\s*---/m.test(source))throw Error('Mermaid configuration directives are unavailable');
 assertFileViewerMermaidSourceHasNoExternalResources(source);
 mermaid.initialize({startOnLoad:false,securityLevel:'strict',maxTextSize:65536,maxEdges:250,flowchart:{htmlLabels:false},fontFamily:'sans-serif',suppressErrorRendering:true});
 const {svg}=await mermaid.render('diagram-'+crypto.randomUUID(),source);
 if(svg.length>8*1024*1024)throw Error('Mermaid SVG exceeds 8 MiB');
 return svg;
}
