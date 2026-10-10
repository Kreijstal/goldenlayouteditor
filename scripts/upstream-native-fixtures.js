// Native records authored here; no private application documents or executables.
const JSZip=require('jszip'),zlib=require('node:zlib');
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
function png(){const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};const chunk=(name,b)=>{const len=Buffer.alloc(4),sum=Buffer.alloc(4),body=Buffer.concat([Buffer.from(name),b]);len.writeUInt32BE(b.length);sum.writeUInt32BE(crc(body));return Buffer.concat([len,body,sum]);};const h=Buffer.alloc(13);h.writeUInt32BE(2);h.writeUInt32BE(2,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,0,0,255,255,0,0,255,0,255,0,0,255,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);}
async function zip(files){const z=new JSZip();for(const [name,data] of Object.entries(files))z.file(name,data);return z.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
async function fixtures(){
 const image=png(),f3d=await zip({'manifest.json':JSON.stringify({name:'Original',version:42}),'thumbnail.png':image});
 const sketch=await zip({'meta.json':JSON.stringify({app:'com.bohemiancoding.sketch3',version:99,pagesAndArtboards:{page:{name:'Original',artboards:{board:{name:'Original board'}}}}}),'pages/page.json':JSON.stringify({_class:'page',name:'Original',layers:[]}),'previews/preview.png':image});
 const procreate=await zip({'thumbnail.png':image});
 const matHeader=Buffer.alloc(128);matHeader.write('MATLAB 5.0 MAT-file, Platform: synthetic, Created by goldenlayouteditor tests');matHeader.writeUInt16LE(0x100,124);matHeader.write('IM',126);
 const element=(type,b)=>Buffer.concat([u32(type),u32(b.length),b,Buffer.alloc((8-b.length%8)%8)]);
 const value=Buffer.alloc(8);value.writeDoubleLE(42);const mat=Buffer.concat([matHeader,element(14,Buffer.concat([element(6,Buffer.concat([u32(6),u32(0)])),element(5,Buffer.concat([u32(1),u32(1)])),element(1,Buffer.from('Original')),element(9,value)]))]);
 const dbf=Buffer.alloc(110);dbf[0]=3;dbf[1]=126;dbf[2]=10;dbf[3]=10;dbf.writeUInt32LE(1,4);dbf.writeUInt16LE(97,8);dbf.writeUInt16LE(12,10);dbf.write('NAME',32);dbf[43]=67;dbf[48]=8;dbf.write('VALUE',64);dbf[75]=78;dbf[80]=3;dbf[96]=13;dbf.write(' Original 42',97);dbf[109]=26;
 const pe=dll=>{const b=Buffer.alloc(512);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128);b.writeUInt16LE(0x14c,132);b.writeUInt16LE(1,134);b.writeUInt16LE(224,148);b.writeUInt16LE(dll?0x2002:2,150);b.writeUInt16LE(0x10b,152);b.writeUInt16LE(3,216);b.write('Original',376);return b;};
 const macho=Buffer.alloc(32);macho.writeUInt32LE(0xfeedfacf);macho.writeUInt32LE(0x01000007,4);macho.writeUInt32LE(3,8);macho.writeUInt32LE(6,12);
 const be16=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};const utf=s=>Buffer.concat([Buffer.from([1]),be16(s.length),Buffer.from(s)]);const klass=Buffer.concat([Buffer.from('cafebabe00000034','hex'),be16(5),utf('Original'),Buffer.from([7]),be16(1),utf('java/lang/Object'),Buffer.from([7]),be16(3),be16(0x21),be16(2),be16(4),Buffer.alloc(8)]);
 // Valid 3.11 timestamp header; marshalled None payload. This reader inspects headers only.
 const pyc=Buffer.concat([Buffer.from('a70d0d0a','hex'),u32(0),u32(0),u32(42),Buffer.from('N')]);
 const lnkHeader=Buffer.alloc(76);lnkHeader.writeUInt32LE(76);Buffer.from('0114020000000000c000000000000046','hex').copy(lnkHeader,4);lnkHeader.writeUInt32LE(0x8c,20);lnkHeader.writeUInt32LE(42,52);lnkHeader.writeUInt32LE(1,60);const lnk=Buffer.concat([lnkHeader,u16(8),Buffer.from('Original','utf16le'),u16(8),Buffer.from('Original','utf16le'),u32(0)]);
 const torrent=Buffer.from('d4:infod6:lengthi42e4:name8:Original12:piece lengthi16384e6:pieces20:01234567890123456789ee');
 return {f3d,f3z:f3d,sketch,procreate,mat,dbf,exe:pe(false),dll:pe(true),dylib:macho,macho,class:klass,pyc,pyo:pyc,lnk,torrent};
}
module.exports={fixtures};
