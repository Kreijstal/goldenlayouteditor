import {boundedZip} from './bounded-zip';
self.onmessage=event=>{try{
 const kind=event.data.kind,archive=boundedZip(new Uint8Array(event.data.bytes));
 const expected='application/vnd.oasis.opendocument.'+(kind==='odp'?'presentation':'text');
 if(new TextDecoder('utf-8',{fatal:true}).decode(archive.read('mimetype',256))!==expected)throw Error('ODF package mimetype does not match extension');
 self.postMessage({xml:archive.read('content.xml',4*1024*1024),manifest:archive.read('META-INF/manifest.xml',4*1024*1024)});
 }catch(error){self.postMessage({error:(error instanceof Error?error.message:String(error)).replace('Unsafe ASiC ZIP','Unsafe ODF ZIP')});}};
