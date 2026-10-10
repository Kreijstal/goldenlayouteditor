const zlib=require('node:zlib');
function mobi(compressed=false){
 const html=Buffer.from('<h1>Original book</h1><p>Value 42</p><script>parent.pwned=true</script>');
 // A literal ASCII PalmDOC stream exercises compression type 2 without guesses.
 const rec0=Buffer.alloc(16+232),palm=Buffer.alloc(78+16+2);palm.write('Original');palm.write('BOOKMOBI',60);palm.writeUInt16BE(2,76);const offset=palm.length;palm.writeUInt32BE(offset,78);palm.writeUInt32BE(offset+rec0.length,86);
 rec0.writeUInt16BE(compressed?2:1);rec0.writeUInt32BE(html.length,4);rec0.writeUInt16BE(1,8);rec0.writeUInt16BE(4096,10);rec0.write('MOBI',16);rec0.writeUInt32BE(232,20);rec0.writeUInt32BE(2,24);rec0.writeUInt32BE(65001,44);rec0.writeUInt32BE(6,52);rec0.writeUInt32BE(0xffffffff,124);return Buffer.concat([palm,rec0,html]);
}
function fixtures(){
 const eml=Buffer.from('From: Author <author@example.test>\r\nTo: Reader <reader@example.test>\r\nSubject: Original message\r\nDate: Sat, 10 Oct 2026 00:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<h1>Original mail 42</h1><script>parent.pwned=true</script>');
 const mbox=Buffer.concat([Buffer.from('From author@example.test Sat Oct 10 00:00:00 2026\n'),eml,Buffer.from('\n\nFrom author@example.test Sat Oct 10 00:00:01 2026\n'),eml]);
 const CFB=require('../public/upstream-viewer/vendor/cfb.min.js'),cfb=CFB.utils.cfb_new();for(const [prop,value] of Object.entries({'0037':'Original message','0042':'Original author','0C1F':'author@example.test','0E04':'reader@example.test','1000':'Original plain body 42'}))CFB.utils.cfb_add(cfb,'__substg1.0_'+prop+'001F',Buffer.from(value+'\0','utf16le'));
 CFB.utils.cfb_add(cfb,'__substg1.0_10130102',Buffer.from('<h1>Original HTML 42</h1><script>parent.pwned=true</script>'));CFB.utils.cfb_add(cfb,'__properties_version1.0',Buffer.alloc(32));
 const msg=Buffer.from(CFB.write(cfb,{type:'buffer'}));const mmp=Buffer.from('<?xml version="1.0"?><lmms-project version="1.0" type="song" creator="LMMS"><head name="Original" bpm="42"/><song><track name="Original instrument" type="0"><instrumenttrack/></track></song></lmms-project>');const length=Buffer.alloc(4);length.writeUInt32BE(mmp.length);return {mobi:mobi(false),azw:mobi(true),eml,mbox,msg,mmp,mmpz:Buffer.concat([length,zlib.deflateSync(mmp)])};
}
module.exports={fixtures,mobi};
