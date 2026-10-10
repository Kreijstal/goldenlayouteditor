import {decodeBcf} from './bcf.js';
self.onmessage=async event=>{try{self.postMessage({model:await decodeBcf(event.data)});}catch(error){self.postMessage({error:error.message});}};
