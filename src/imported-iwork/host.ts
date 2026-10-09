export type FileRenderContext=any;export type FileViewerFitRequest=any;export type FileViewerFitResult=any;export type FileViewerRenderedInstance=any;export type FileViewerZoomState=any;
export const registerFileViewerZoomProvider=(target:HTMLElement,provider:any)=>Object.assign(target,{iworkZoom:provider});
export const unregisterFileViewerZoomProvider=(target:HTMLElement)=>{delete (target as any).iworkZoom;};
export const resolveFileViewerFitScale=({mode,viewportWidth,viewportHeight,contentWidth,contentHeight,minScale,maxScale}:any)=>{
 if(Math.min(viewportWidth,viewportHeight,contentWidth,contentHeight)<=0)return undefined;
 const w=viewportWidth/contentWidth,h=viewportHeight/contentHeight;
 const value=mode==='width'?w:mode==='height'?h:mode==='cover'?Math.max(w,h):mode==='actual'?1:mode==='scale-down'?Math.min(1,w,h):Math.min(w,h);
 if(!Number.isFinite(value)||value<=0)return undefined;return Math.min(maxScale,Math.max(minScale,value));
};
