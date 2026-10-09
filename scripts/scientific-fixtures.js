const JSZip=require('jszip');
function classicNetcdf(){
 const words=[];const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);words.push(b);};const name=s=>{const b=Buffer.from(s);u32(b.length);words.push(b,Buffer.alloc((4-b.length%4)%4));};
 words.push(Buffer.from('CDF\x01'));u32(0);u32(10);u32(1);name('x');u32(3);u32(0);u32(0);u32(11);u32(1);name('values');u32(1);u32(0);u32(0);u32(0);u32(5);u32(12);u32(0);
 const header=Buffer.concat(words);header.writeUInt32BE(header.length,header.length-4);const values=Buffer.alloc(12);[1.5,2.5,3.5].forEach((n,i)=>values.writeFloatBE(n,i*4));return Buffer.concat([header,values]);
}
async function numpyFixtures(){const {dump}=await import('npyjs');const array=Buffer.from(dump(new Float32Array([1,2,3,4,5,6]),[2,3]));const zip=new JSZip();zip.file('matrix.npy',array);zip.file('other.npy',array);return {npy:array,npz:await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})};}
module.exports={classicNetcdf,numpyFixtures};
