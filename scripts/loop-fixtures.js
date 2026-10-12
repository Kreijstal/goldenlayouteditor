const zlib=require('node:zlib');
function compact(v) {
    if (v instanceof Uint8Array) {const n=Buffer.alloc(5);n[0]=35;n.writeUInt32LE(v.length,1);return Buffer.concat([n,Buffer.from(v)]);}
    if (typeof v==='string') {const b=Buffer.from(v),n=Buffer.alloc(5);n[0]=16;n.writeUInt32LE(b.length,1);return Buffer.concat([n,b]);}
    if (typeof v==='number') {const n=Buffer.alloc(5);n[0]=6;n.writeInt32LE(v,1);return n;}
    if (typeof v==='boolean') return Buffer.from([v?11:12]);
    if (Array.isArray(v)) return Buffer.concat([Buffer.from([49]),...v.map(compact),Buffer.from([50])]);
    return Buffer.concat([Buffer.from([51]),...Object.entries(v).flatMap(([k,x])=>[compact(k),compact(x)]),Buffer.from([52])]);
}
function fixture({text='Hallo, 世界! <script>parent.hacked=1</script>',empty=false,deltas=false,start=0}={}) {
    const chunk={chunkStartSegmentIndex:start,chunkSegmentCount:empty?1:2,segmentTexts:[{marker:{refType:1},props:{nodeType:'Paragraph'}},...(empty?[]:[{text,props:{bold:true}}])]};
    const snapshot={mrv:'1.0',cv:'1.0',snapshot:{id:'test',sequenceNumber:0,treeNodes:[{name:'.app',children:[{name:'text',children:[{name:'content',children:[{name:'header',value:'blob1'}]}]}]}]},blobs:[{id:'blob1',data:Buffer.from(JSON.stringify(chunk))}]};
    if(deltas) snapshot.deltas={firstSequenceNumber:1,deltas:['{}']};
    const payload=compact(snapshot);
    // Minimal synthetic envelope for the supported extractor, not a Loop-generated file.
    const prefix=Buffer.concat([Buffer.from('578f1cd0d067344b9ffb4f5a48069ec5','hex'),Buffer.from('Microsoft.Prague 0.2.1\0Microsoft.PragueOptimizedSnapshotWithOpsNode\0','utf16le'),Buffer.from([5,4,100,97,116,97,9,36,0,19,5,5,1])]);
    return Buffer.concat([prefix,zlib.gzipSync(payload),Buffer.from('trailing Prague records')]);
}
module.exports={compact,fixture};
