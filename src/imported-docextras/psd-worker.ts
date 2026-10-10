import {readPsd,initializeCanvas} from 'ag-psd';
initializeCanvas((width,height)=>new OffscreenCanvas(width,height) as unknown as HTMLCanvasElement,(width,height)=>new ImageData(width,height));
self.onmessage=event=>{try{
 const bytes=new Uint8Array(event.data);if(bytes.length<26||bytes.length>64*1024*1024)throw Error('PSD profile input must be 26 bytes–64 MiB');const view=new DataView(bytes.buffer),width=view.getUint32(18),height=view.getUint32(14),channels=view.getUint16(12);
 if(view.getUint32(0)!==0x38425053||view.getUint16(4)!==1||view.getUint16(22)!==8||view.getUint16(24)!==3||channels<3||channels>16||!width||!height||width*height>16*1024*1024)throw Error('Only PSD version-1 8-bit RGB composites up to 16 megapixels are supported');
 const psd=readPsd(bytes,{useImageData:true,skipLayerImageData:true,skipThumbnail:true});if(!psd.imageData||psd.imageData.data.length!==width*height*4)throw Error('No native PSD composite image');
 const names:string[]=[];function layers(children:any[],depth=0){if(depth>64)throw Error('PSD layer depth exceeds 64');for(const child of children||[]){if(names.length>=10000)throw Error('PSD exceeds 10000 layer names');names.push(child.name||'(Unnamed layer)');if(child.children)layers(child.children,depth+1);}}layers(psd.children);
 const data=psd.imageData.data;self.postMessage({width,height,names,data},[data.buffer]);
 }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
