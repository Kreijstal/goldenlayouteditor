// SPDX-License-Identifier: GPL-3.0-only
import {readDra} from './reader.mjs';
self.onmessage=e=>{try{self.postMessage({model:readDra(e.data.bytes)});}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
