import {IfcAPI} from 'web-ifc';
self.onmessage=async({data:{bytes}})=>{
 const api=new IfcAPI();let model;
 // Errors are transported to the host; finally closes the native model.
 try{
  if(bytes.byteLength>128*1024*1024)throw new Error('IFC preview limit is 128 MiB');
  if(!new TextDecoder().decode(bytes.subarray(0,1024)).includes('ISO-10303-21;'))throw new Error('Not an IFC STEP file');
  await api.Init(path=>new URL(path,self.location.href).href,true);
  model=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:true});
  if(!api.IsModelOpen(model))throw new Error('Could not open IFC model');
  const geometries=new Map(),instances=[];let totalBytes=0;
  api.StreamAllMeshes(model,mesh=>{
   for(let i=0;i<mesh.geometries.size();i++){
    if(instances.length>=100000)throw new Error('IFC exceeds 100,000 mesh placements');
    const placed=mesh.geometries.get(i),id=placed.geometryExpressID;
    if(!geometries.has(id)){
     const geometry=api.GetGeometry(model,id);
     try{
      const vertices=api.GetVertexArray(geometry.GetVertexData(),geometry.GetVertexDataSize()).slice();
      const indices=api.GetIndexArray(geometry.GetIndexData(),geometry.GetIndexDataSize()).slice();
      totalBytes+=vertices.byteLength+indices.byteLength;if(totalBytes>256*1024*1024)throw new Error('IFC geometry exceeds 256 MiB');
      if(vertices.length%6 || indices.length%3 || !vertices.every(Number.isFinite))throw new Error('Invalid IFC mesh');
      geometries.set(id,{id,vertices,indices});
     }finally{geometry.delete();}
    }
    instances.push({id,expressID:mesh.expressID,color:placed.color,matrix:placed.flatTransformation});
   }
  });
  if(!instances.length)throw new Error('No renderable geometry in IFC model');
  const meshes=[...geometries.values()];const transfer=meshes.flatMap(g=>[g.vertices.buffer,g.indices.buffer]);
  self.postMessage({model:{schema:api.GetModelSchema(model),meshes,instances}},transfer);
 }catch(error){self.postMessage({error:error.message});}
 finally{if(model!==undefined && api.IsModelOpen(model))api.CloseModel(model);}
};
