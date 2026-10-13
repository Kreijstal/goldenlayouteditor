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
// The meshes grouped as the file arranges the building: project, site, building, storeys,
// spaces and their elements, each group carrying its IFC id and type; elements outside that
// structure in a group of their own
function buildIfcObject(THREE,model){
 const root=new THREE.Group();const geometries=new Map(),meshesOf=new Map(),info=model.info||{};
 for(const mesh of model.meshes){
  const geometry=new THREE.BufferGeometry(),count=mesh.vertices.length/6;
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3);
  for(let i=0;i<count;i++){positions.set(mesh.vertices.subarray(i*6,i*6+3),i*3);normals.set(mesh.vertices.subarray(i*6+3,i*6+6),i*3);}
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(mesh.indices,1));geometries.set(mesh.id,geometry);
 }
 for(const instance of model.instances){
  const c=instance.color,material=new THREE.MeshStandardMaterial({color:new THREE.Color(c.x,c.y,c.z),opacity:c.w,transparent:c.w<1,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometries.get(instance.id),material);mesh.name='IFC #'+instance.expressID;mesh.userData.expressID=instance.expressID;mesh.applyMatrix4(new THREE.Matrix4().fromArray(instance.matrix));
  if(!meshesOf.has(instance.expressID))meshesOf.set(instance.expressID,[]);meshesOf.get(instance.expressID).push(mesh);
 }
 const node=(id,children)=>{
  const group=new THREE.Group(),i=info[id]||{};group.name=i.attrs?.Name||i.attrs?.LongName||i.type||'#'+id;group.userData.ifc={id,type:i.type||''};
  for(const mesh of meshesOf.get(id)||[])group.add(mesh);meshesOf.delete(id);for(const child of children)group.add(child);return group;
 };
 const build=n=>node(n.id,n.children.map(build));
 if(model.structure)root.add(build(model.structure));
 if(meshesOf.size){const rest=new THREE.Group();rest.name='Outside the spatial structure';rest.userData.ifc={type:''};for(const id of [...meshesOf.keys()])rest.add(node(id,[]));root.add(rest);}
 root.userData.ifcSchema=model.schema;root.userData.ifcInfo=info;return root;
}
module.exports={readIfc,buildIfcObject};
