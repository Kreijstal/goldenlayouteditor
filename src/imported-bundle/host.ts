// Small host adapter for the imported Flyfish renderer; no global framework.
import * as pako from 'pako';
import {messages} from './messages.js';
export type FileRenderContext = {options?: Record<string,unknown>};
export type FileViewerRenderedInstance = {$el: HTMLElement;unmount():void};
export type FileViewerZoomState = {scale:number;label:string;canZoomIn:boolean;canZoomOut:boolean;canReset:boolean;minScale:number;maxScale:number};
export const getFileViewerPakoLoader = () => async () => pako;
export const createFileViewerTranslator = () => (key:string, values:Record<string,unknown> = {}) => {
 const message = messages[key as keyof typeof messages];
 if(message === undefined)throw new Error('Missing bundle message: '+key);
 return message.replace(/\{([^}]+)\}/g,(_,name)=>String(values[name]));
};
export const createFileViewerZoomChangeEmitter = () => {
 const listeners = new Set<()=>void>();
 return {emit(){listeners.forEach(f=>f());},subscribe(f:()=>void){listeners.add(f);return()=>listeners.delete(f);}};
};
export const registerFileViewerZoomProvider = (root:HTMLElement,provider:unknown) => {Object.assign(root,{bundleZoom:provider});};
export const unregisterFileViewerZoomProvider = (root:HTMLElement) => {delete (root as HTMLElement & {bundleZoom?:unknown}).bundleZoom;};
