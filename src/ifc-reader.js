const {resolveAssetUrl}=require('./lazy-viewers');
function readIfc(buffer,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new DOMException('IFC load cancelled','AbortError'));return;}
  const worker=new Worker(resolveAssetUrl('ifc-viewer/worker.js'),{type:'module'});
  const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);worker.terminate();};
  const abort=()=>{cleanup();reject(new DOMException('IFC load cancelled','AbortError'));};
  const timeout=setTimeout(()=>{cleanup();reject(new Error('IFC preview exceeded 60 seconds'));},60000);
  signal?.addEventListener('abort',abort,{once:true});
  worker.onmessage=({data})=>{cleanup();data.error?reject(new Error(data.error)):resolve(data.model);};
  worker.onerror=event=>{cleanup();reject(new Error(event.message));};
  worker.postMessage({bytes:new Uint8Array(buffer)});
 });
}
function buildIfcObject(THREE,model){
 const group=new THREE.Group();const geometries=new Map();
 for(const mesh of model.meshes){
  const geometry=new THREE.BufferGeometry(),count=mesh.vertices.length/6;
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3);
  for(let i=0;i<count;i++){positions.set(mesh.vertices.subarray(i*6,i*6+3),i*3);normals.set(mesh.vertices.subarray(i*6+3,i*6+6),i*3);}
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(mesh.indices,1));geometries.set(mesh.id,geometry);
 }
 for(const instance of model.instances){
  const c=instance.color,material=new THREE.MeshStandardMaterial({color:new THREE.Color(c.x,c.y,c.z),opacity:c.w,transparent:c.w<1,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometries.get(instance.id),material);mesh.name='IFC #'+instance.expressID;mesh.userData.expressID=instance.expressID;mesh.applyMatrix4(new THREE.Matrix4().fromArray(instance.matrix));group.add(mesh);
 }
 group.userData.ifcSchema=model.schema;return group;
}
module.exports={readIfc,buildIfcObject};
