import {readAzw3} from './reader.mjs';
self.onmessage=e=>{try{self.postMessage({model:readAzw3(e.data.bytes)});}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
