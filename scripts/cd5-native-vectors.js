// Optional differential verification inputs; requires a local vendor corpus.
const fs=require('node:fs'),path=require('node:path');
const {parseCd5,decodeKernel,decodeLayer,layerRgba}=require('../src/cd5');
const [root,destination]=process.argv.slice(2);
if(!root||!destination)throw new Error('Usage: node scripts/cd5-native-vectors.js CORPUS OUTPUT.ndjson');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?walk(path.join(dir,f.name)):[path.join(dir,f.name)]);}
const counts={},profiles={},vectors=[],encoded=b=>Buffer.from(b).toString('base64');
for(const file of walk(root).filter(f=>/\.cd5$/i.test(f))){
    const doc=parseCd5(new Uint8Array(fs.readFileSync(file)));
    for(const l of doc.layers){
        for(const b of l.bands){
            const size=new DataView(b.buffer,b.byteOffset,b.length).getUint32(8,true),capacity=Math.ceil(size/4)*4+65536;let src=b.subarray(32);
            for(let i=31;i>=16;i--){
                const id=b[i];if(!id)continue;const out=decodeKernel(id,src,capacity);
                if((counts[id]||0)<10){vectors.push({type:'kernel',id,file:path.basename(file),capacity,src:encoded(src),out:encoded(out)});counts[id]=(counts[id]||0)+1;}
                src=out;
            }
        }
        if(l.pixelSize && l.width*l.height<=65536 && (profiles[l.profile]||0)<3){
            const pixels=decodeLayer(l).pixels;
            vectors.push({type:'profile',profile:l.profile,channels:l.channels,width:l.width,height:l.height,file:path.basename(file),src:encoded(pixels),out:encoded(layerRgba(l,pixels))});
            profiles[l.profile]=(profiles[l.profile]||0)+1;
        }
    }
    if(Object.values(counts).filter(n=>n===10).length===5 && Object.values(profiles).filter(n=>n===3).length===6)break;
}
fs.writeFileSync(destination,vectors.map(v=>JSON.stringify(v)).join('\n')+'\n');console.log({kernels:counts,profiles,vectors:vectors.length});
