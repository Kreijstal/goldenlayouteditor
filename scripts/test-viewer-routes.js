// Verify that newly supported suffixes reach their reader before generic routes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const acorn=require('acorn'),walk=require('acorn-walk');
const source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});let init;
walk.simple(ast,{VariableDeclarator(node){if(node.id.name==='FILE_VIEWERS')init=node.init;}});assert(init);
// Name-sniffing predicates are irrelevant for these unambiguous suffixes; keep
// them callable while evaluating the actual route array and regular expressions.
const bindings={};walk.simple(init,{Identifier(node){bindings[node.name]=()=>true;}});
const routes=vm.runInNewContext('('+source.slice(init.start,init.end)+')',bindings);
const groups={mediaCodecViewer:'aif aifc aiff amr au caf snd oga weba m4b wma asf divx f4v flv m2v mpe mpv rm rmvb vob 3g2',wordPerfectViewer:'wp wp5 wp6 wpd',upstreamViewer:'bcf db3 s3db sl3 gpkg mbtiles fa fasta fna faa ffn frn fsa mpfa fq fastq bed gff gff3 gff2 gtf hl7 hl7v2 msh ini cfg conf properties env toml yaml yml jsonc json5 jsonl ndjson ldjson xsd xsl xslt wsdl pom csproj props targets resx rss atom plist stringsdict strings mobi azw eml mbox msg mmp mmpz ppt pot pps bson cbor msgpack mpk f3d f3z sketch procreate mat dbf exe dll dylib macho class pyc pyo lnk torrent',layoutViewer:'gds gdsii',columnarViewer:'parquet avro arrow feather ipc',wordBinaryViewer:'doc dot',iworkViewer:'pages numbers key',model3dViewer:'usd usda usdc usdz fbx pcd vtk vtp xyz ifc',bundleViewer:'bundle',scientificViewer:'h5 hdf hdf5 he5 nc nc4 netcdf npy npz',archiveReader:'7z ar cpio cab rar cbr cb7 cbt xar zipx bz2 bzip2 xz lzma lha lzh rpm srpm deb udeb tbz tbz2 txz tar.bz2 tar.xz gzip aab mcpack mctemplate mcworld',adobeContainerViewer:'indd indt xd icml idms inx ase aco abr csh pat grd asl'};
let count=0;for(const [component,formats] of Object.entries(groups))for(const format of formats.split(' ')){const route=routes.find(r=>r.re.test('sample.'+format));assert.equal(route?.componentType,component,format+' default reader');count++;}
console.log(count+' imported-format routes select their actual readers.');
// Byte routing must agree with the viewer routes in both virtual and server FS.
for(const filename of ['src/vfs.js','ws-handler.js']){
 const text=fs.readFileSync(path.join(__dirname,'..',filename),'utf8');let declared,iff;
 walk.simple(acorn.parse(text,{ecmaVersion:'latest'}),{VariableDeclarator(n){if(n.id.name==='SERVED_EXTENSIONS')declared=n.init;if(n.id.name==='IFF_PICTURE_RE')iff=n.init;}});
 const served=vm.runInNewContext(text.slice(declared.start,declared.end));
 for(const extensions of Object.values(groups))for(const ext of extensions.split(' '))if(!ext.includes('.'))assert(served.has(ext),filename+' binary route '+ext);
 if(!iff)continue;const pattern=vm.runInNewContext(text.slice(iff.start,iff.end));assert(pattern.test('FORM\0\0\0\0ILBM'));assert(!pattern.test('FORMabcdTEXT'));
}
