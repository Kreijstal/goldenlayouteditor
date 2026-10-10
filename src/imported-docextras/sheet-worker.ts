import * as XLSX from 'xlsx';
import {SaxesParser} from 'saxes';
import {boundedZip} from './bounded-zip';
self.onmessage=event=>{try{
 const bytes=new Uint8Array(event.data.bytes),kind=event.data.kind;if(bytes.length>32*1024*1024)throw Error('Workbook input exceeds 32 MiB');
 if(['xlam','xltm','xltx'].includes(kind)){
  const archive=boundedZip(bytes);let types='',xmlElements=0;
  for(const entry of archive.entries){if(entry.directory)continue;const data=archive.read(entry.name,8*1024*1024);if(entry.name.endsWith('.xml')){if(data.length>4*1024*1024)throw Error('Workbook XML exceeds 4 MiB');const xml=new TextDecoder('utf-8',{fatal:true}).decode(data);const parser=new SaxesParser({xmlns:true});parser.on('doctype',()=>{throw Error('Workbook DTDs are unsupported');});parser.on('opentag',()=>{if(++xmlElements>75000)throw Error('Workbook exceeds 75000 XML elements');});parser.write(xml).close();if(entry.name==='[Content_Types].xml')types=xml;}}
  const expected={xlam:'application/vnd.ms-excel.addin.macroEnabled.main+xml',xltm:'application/vnd.ms-excel.template.macroEnabled.main+xml',xltx:'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'}[kind];
  const parser=new SaxesParser({xmlns:true});let found=false;parser.on('opentag',tag=>{if(tag.local==='Override'&&tag.attributes.PartName?.value==='/xl/workbook.xml'&&tag.attributes.ContentType?.value===expected)found=true;});parser.write(types).close();if(!found)throw Error('Workbook package content type does not match extension');
 }else{
  if(bytes.length<512||!bytes.subarray(0,8).every((byte,i)=>byte===[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1][i]))throw Error('Expected native BIFF compound workbook');
  const cfb=XLSX.CFB.read(bytes,{type:'array'}),stream=XLSX.CFB.find(cfb,'Workbook')||XLSX.CFB.find(cfb,'Book');if(!stream||!stream.content)throw Error('Missing native Workbook stream');
  const data=stream.content,view=new DataView(data.buffer,data.byteOffset,data.byteLength);if(data.length<12||view.getUint16(0,true)!==0x0809||![0x0500,0x0600].includes(view.getUint16(4,true))||view.getUint16(6,true)!==5)throw Error('Expected native BIFF 5/8 workbook globals');let at=0,marker=false,eof=false,count=0;
  while(at+4<=data.length){const id=view.getUint16(at,true),size=view.getUint16(at+2,true);if(at+4+size>data.length||++count>100000)throw Error('Invalid BIFF workbook record');if(id===(kind==='xla'?0x0087:0x0060))marker=true;at+=4+size;if(id===0x000a){eof=true;break;}}
  if(!eof||!marker)throw Error('Missing native BIFF add-in/template marker');
 }
 const wb=XLSX.read(bytes,{type:'array',sheetRows:512,cellFormula:true,cellHTML:false,cellDates:true,bookVBA:false});if(wb.SheetNames.length>32)throw Error('Workbook exceeds 32 sheets');let total=0;const sheets=[];
 for(const name of wb.SheetNames){const sheet=wb.Sheets[name],cells=[];let truncated=Boolean(sheet['!fullref']);for(const [address,cell]of Object.entries(sheet)){if(address.startsWith('!'))continue;const position=XLSX.utils.decode_cell(address);if(position.r>=512||position.c>=128){truncated=true;continue;}if(++total>30000)throw Error('Workbook exceeds 30000 preview cells');cells.push({address,row:position.r,column:position.c,value:cell.v instanceof Date?cell.v.toISOString():cell.v,formula:cell.f,type:cell.t});}sheets.push({name,cells,truncated});}
 self.postMessage({model:{sheets,format:kind,summary:sheets.length+' sheets · '+total+' cells'}});
 }catch(error){self.postMessage({error:(error instanceof Error?error.message:String(error)).replace('Unsafe ASiC ZIP','Unsafe workbook ZIP')});}};
