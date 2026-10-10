import {parseUmdBook} from './umd-parser';
self.onmessage=event=>{try{self.postMessage({book:parseUmdBook(event.data)});}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
