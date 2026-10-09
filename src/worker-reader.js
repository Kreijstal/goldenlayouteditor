const {resolveAssetUrl}=require('./lazy-viewers');
function readWorker(asset,payload,signal){
 return new Promise((resolve,reject)=>{
  if(signal.aborted){resolve({cancelled:true});return;}
  const worker=new Worker(resolveAssetUrl(asset),{type:'module'});
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);worker.terminate();};
  const cancel=()=>{cleanup();resolve({cancelled:true});};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Preview exceeded 60 seconds'));},60000);
  signal.addEventListener('abort',cancel,{once:true});
  worker.onmessage=({data})=>{cleanup();data.error?reject(new Error(data.error)):resolve(data.model);};
  worker.onerror=event=>{cleanup();reject(new Error(event.message));};
  worker.postMessage(payload);
 });
}
module.exports={readWorker};
