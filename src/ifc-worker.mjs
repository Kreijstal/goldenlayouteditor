import {IfcAPI,IFCRELDEFINESBYPROPERTIES} from 'web-ifc';
// an IFC value as text: labels, numbers, booleans, enumerations
const text=v=>{if(v==null)return '';if(Array.isArray(v))return v.map(text).join(', ');const x=v._representationValue??v.value;return x==null?'':typeof x==='number'?String(+x.toPrecision(10)):String(x);};
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
  // the building as the file arranges it (project, site, building, storeys, spaces, their elements),
  // what each says of itself, and its property sets and quantities
  const info={};const describe=id=>{if(info[id])return;const line=api.GetLine(model,id);info[id]={type:api.GetNameFromTypeCode(line.type),attrs:Object.fromEntries(['Name','LongName','Description','ObjectType','PredefinedType','Tag','GlobalId'].map(k=>[k,text(line[k])]).filter(([,v])=>v)),sets:[]};};
  let nodes=0;const walk=n=>{if(++nodes>200000)throw new Error('IFC exceeds 200,000 structure nodes');describe(n.expressID);return{id:n.expressID,children:n.children.map(walk)};};
  const structure=walk(await api.properties.getSpatialStructure(model,false));
  for(const instance of instances)describe(instance.expressID);
  const rels=api.GetLineIDsWithType(model,IFCRELDEFINESBYPROPERTIES);
  for(let i=0;i<rels.size();i++){
   const rel=api.GetLine(model,rels.get(i)),targets=(rel.RelatedObjects||[]).map(o=>info[o.value]).filter(Boolean);if(!targets.length)continue;
   const def=api.GetLine(model,rel.RelatingPropertyDefinition.value,true),values=[];
   for(const prop of def.HasProperties||def.Quantities||[]){const key=Object.keys(prop).find(k=>/Value(s)?$/.test(k)&&prop[k]!=null);values.push([text(prop.Name),key?text(prop[key]):'']);}
   for(const target of targets)target.sets.push({name:text(def.Name),values});
  }
  const meshes=[...geometries.values()];const transfer=meshes.flatMap(g=>[g.vertices.buffer,g.indices.buffer]);
  self.postMessage({model:{schema:api.GetModelSchema(model),meshes,instances,structure,info}},transfer);
 }catch(error){self.postMessage({error:error.message});}
 finally{if(model!==undefined && api.IsModelOpen(model))api.CloseModel(model);}
};
