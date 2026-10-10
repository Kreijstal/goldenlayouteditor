self.onmessage=async event=>{try{
 const {bytes,name}=event.data;let result;const extension=name.split('.').pop().toLowerCase();
 if(['asice','asics','sce','scs'].includes(extension)){const {inspectAsicContainer}=await import('./structured/asic');result=await inspectAsicContainer(bytes,{maxTotalUncompressedBytes:64*1024*1024});}
 else if(extension==='jws'){const {inspectJws}=await import('./structured/jws');result=await inspectJws(bytes);}
 else{const {inspectSignatureContainer,inspectEvidenceRecord}=await import('./signatureAsn1');result=extension==='ers'?await inspectEvidenceRecord(bytes):await inspectSignatureContainer(bytes,{sourceFilename:name,extensionHint:extension});if(result.kind==='unknown')throw Error('Unrecognized native signature container');}
 // Keep binary lengths and a bounded prefix, rather than allocating huge JSON arrays.
 const model=JSON.parse(JSON.stringify(result,(_,value)=>value instanceof Uint8Array?{bytes:value.length,hexPrefix:Array.from(value.subarray(0,32),b=>b.toString(16).padStart(2,'0')).join(''),truncated:value.length>32}:value));self.postMessage({model});
 }catch(error){self.postMessage({error:error.message});}};
