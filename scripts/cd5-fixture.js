// Original test document, generated from explicit known pixels; no vendor assets.
function u32(n){const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;}
function record(tag,data){return Buffer.concat([u32(tag),u32(data.length),data]);}
function createFixture(){
    const header=Buffer.alloc(32);header.write('_CD5');header.writeUInt32LE(32,4);header.writeUInt32LE(0x4000a,8);header.writeUInt32LE(1,12);header.writeUInt32LE(2,16);
    const layers=[{profile:0,channels:4,pixels:[0,0,255,255,0,255,0,255,255,0,0,255,255,128,255,0],name:'RGBA test'},{profile:1,channels:1,pixels:[0,80,160,255],name:'Gray test'}];
    const records=[];
    for(const l of layers){
        const desc=Buffer.alloc(128);desc.writeUInt32LE(1,4);desc.writeUInt32LE(2,16);desc.writeUInt32LE(2,20);desc[24]=l.profile;desc[25]=l.channels;desc.writeUInt32LE(l.pixels.length,32);desc.write(l.name,64,'utf16le');records.push(record(1,desc));
        const encoded=Buffer.from([l.pixels.length-1,...l.pixels,0]);const band=Buffer.alloc(32);band.writeUInt32LE(encoded.length,4);band.writeUInt32LE(l.pixels.length,8);band.writeUInt32LE(1,12);band[16]=1;records.push(record(2,Buffer.concat([band,encoded])));
    }
    return Buffer.concat([header,...records,record(255,Buffer.alloc(0))]);
}
module.exports={createFixture};
