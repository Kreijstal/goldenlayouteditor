const JSZip=require('jszip');const zlib=require('node:zlib');
function png(){
 const crc=bytes=>{let value=0xffffffff;for(const b of bytes){value^=b;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const payload=Buffer.concat([Buffer.from(type),data]);const checksum=Buffer.alloc(4);checksum.writeUInt32BE(crc(payload));return Buffer.concat([length,payload,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,0,0,255,255,0,0,255,0,255,0,0,255,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function indd(image){
 const xmp=Buffer.from(`<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/"><rdf:li><xmpGImg:format>PNG</xmpGImg:format><xmpGImg:width>2</xmpGImg:width><xmpGImg:height>2</xmpGImg:height><xmpGImg:image>${image.toString('base64')}</xmpGImg:image></rdf:li></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`);
 const file=Buffer.alloc(8192+32+4+xmp.length+32);
 for(const base of [0,4096]){Buffer.from('0606edf5d81d46e5bd31efe7fe74b71d','hex').copy(file,base);file.write('DOCUMENT',base+16);file[base+24]=1;file.writeUInt32LE(20,base+29);file.writeUInt32LE(base?2:1,base+264);file.writeUInt32LE(2,base+280);}
 const offset=8192;Buffer.from('de39397951884b6c8e63eef8aee0dd38','hex').copy(file,offset);file.writeUInt32LE(xmp.length+4,offset+24);file.writeUInt32LE(xmp.length,offset+32);xmp.copy(file,offset+36);Buffer.from('fdcedb70f7864b4fa4d3c728b3417106','hex').copy(file,offset+36+xmp.length);return file;
}
function palette(format){
 if(format==='aco'){const bytes=Buffer.alloc(14);bytes.writeUInt16BE(1,0);bytes.writeUInt16BE(1,2);bytes.writeUInt16BE(65535,6);return bytes;}
 const name=Buffer.from([0,4,0,82,0,101,0,100,0,0]);const values=Buffer.alloc(14);values.writeFloatBE(1,0);const body=Buffer.concat([name,Buffer.from('RGB '),values]);const header=Buffer.alloc(18);header.write('ASEF',0);header.writeUInt16BE(1,4);header.writeUInt32BE(1,8);header.writeUInt16BE(1,12);header.writeUInt32BE(body.length,14);return Buffer.concat([header,body]);
}
async function fixtures(){
 const image=png();const xd=new JSZip();xd.file('mimetype','application/vnd.adobe.sparkler.project+dcxucf');xd.file('manifest',JSON.stringify({name:'Authored XD fixture',version:'1.0',components:[{path:'preview.png',rel:'preview',type:'image/png'}]}));xd.file('preview.png',image);xd.file('resources/graphics/graphicContent.agc',JSON.stringify({artboards:{board1:{name:'Test board',width:2,height:2}},children:[{type:'shape',name:'Red rectangle'}]}));
 const story=type=>Buffer.from(`<?xml version="1.0"?><?aid SnippetType="${type}"?><Document DOMVersion="8.0"><Story Self="story"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Normal"><CharacterStyleRange FontStyle="Bold"><Content>Hello &lt;script&gt;safe&lt;/script&gt;</Content></CharacterStyleRange></ParagraphStyleRange></Story></Document>`);
 return {indd:indd(image),indt:indd(image),xd:await xd.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),icml:story('InCopyInterchange'),idms:story('PageItem'),inx:Buffer.from('<?xml version="1.0"?><docu/>'),ase:palette('ase'),aco:palette('aco')};
}
module.exports={fixtures};
