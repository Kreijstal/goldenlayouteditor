const {registerPlugin}=require('./plugins');
const {ArchiveSession,CompressionSession,XarSession}=require('./archive-session');
const {readBytes,element}=require('./imported-viewer-panel');
let ctx;
class ArchivePanel{
 constructor(container,state){
  this.root=container.element;this.destroyed=false;this.sequence=0;this.memoryIds=[];
  this.root.style.cssText+=';height:100%;display:flex;flex-direction:column;overflow:hidden;background:#20242a;color:#eee;font:14px system-ui';
  const bar=element('div');bar.style.cssText='padding:10px;display:flex;gap:10px';const open=element('button','Open archive',bar);const input=element('input',undefined,bar);input.type='file';input.hidden=true;input.accept='.7z,.ar,.cpio,.cab,.rar,.cbr,.cb7,.cbt,.xar,.zipx,.bz2,.bzip2,.xz,.lzma,.lha,.lzh,.rpm,.srpm,.deb,.udeb,.tbz,.tbz2,.txz,.tar.bz2,.tar.xz,.gzip,.aab,.mcpack,.mctemplate,.mcworld';
  this.search=element('input',undefined,bar);this.search.type='search';this.search.placeholder='Find entry';this.search.setAttribute('aria-label','Find entry');this.search.oninput=()=>this.filter();this.label=element('span','Choose an archive',bar);
  this.host=element('div');this.host.style.cssText='flex:1;min-height:0;display:flex;overflow:hidden';this.root.replaceChildren(bar,this.host);
  open.onclick=()=>input.click();input.onchange=async()=>{const file=input.files[0];if(file)await this.show(new Uint8Array(await file.arrayBuffer()),file.name);};
  container.on('destroy',()=>{this.destroyed=true;this.sequence++;this.session?.close();this.host.replaceChildren();});this.ready=this.init(state||{});
 }
 async init(state){if(state.fileId){const file=ctx.projectFiles[state.fileId];if(!file)throw new Error('File no longer exists');await this.show(await readBytes(file,ctx),file.name);}}
 async show(bytes,name){
  if(this.destroyed)return;if(bytes.byteLength>128*1024*1024)throw new Error('Archive preview limit is 128 MiB');const sequence=++this.sequence;this.session?.close();this.host.replaceChildren();this.label.textContent=name+' · reading…';const stream=/\.(bz2|bzip2|xz|lzma|gzip)$/i.test(name)&&!/\.tar\.(bz2|xz)$/i.test(name);const session=/\.xar$/i.test(name)?new XarSession():stream?new CompressionSession():new ArchiveSession();this.session=session;
  // Closing while libarchive is pending is an expected lifecycle cancellation.
  let entries;try{entries=await session.open(new File([bytes],name));}catch(error){if(this.destroyed||sequence!==this.sequence)return;session.close();throw error;}
  if(this.destroyed||sequence!==this.sequence){session.close();return;}
  this.label.textContent=name+' · '+entries.length+' entries';this.list=element('div',undefined,this.host);this.list.className='archive-entries';this.list.style.cssText='width:40%;min-width:180px;overflow:auto;padding:10px;border-right:1px solid #49505c';this.preview=element('div',undefined,this.host);this.preview.className='archive-preview';this.preview.style.cssText='flex:1;overflow:auto;padding:15px';
  for(const entry of entries){const button=element('button',entry.path+' · '+entry.size+' B',this.list);button.style.cssText='display:block;width:100%;text-align:left;padding:8px;margin-bottom:5px;overflow-wrap:anywhere';button.disabled=entry.type!=='FILE';button.onclick=()=>this.select(entry,session,sequence);}
  if(!entries.length)element('p','No supported entries: the archive may be empty or use an unsupported variant.',this.preview);this.filter();
 }
 filter(){if(this.list)for(const button of this.list.children){const hidden=!button.textContent.toLowerCase().includes(this.search.value.toLowerCase());button.hidden=hidden;button.style.display=hidden?'none':'block';}}
 async select(entry,session,sequence){
  const selection=this.selection=(this.selection||0)+1;this.preview.replaceChildren();element('p','Extracting '+entry.path,this.preview);let bytes;try{bytes=await session.extract(entry);}catch(error){if(this.destroyed||sequence!==this.sequence)return;session.close();this.label.textContent=error.message;throw error;}
  if(this.destroyed||sequence!==this.sequence||selection!==this.selection)return;
  this.preview.replaceChildren();element('h2',entry.path,this.preview);
  const open=element('button','Open in viewer',this.preview);open.onclick=()=>{
   const name=entry.fileName.split(/[\\/]/).pop();const id=ctx.addMemoryFile({name,content:binary?'':new TextDecoder().decode(bytes),bytes,...(binary?{viewType:'binary'}:{})},'.in-memory-archive-'+Date.now()+'/'+name,bytes);this.memoryIds.push(id);const viewer=ctx.viewersForFile(id)[0];ctx.openEditorTab(viewer.componentType,viewer.state,viewer.title,viewer.id);
  };
  const download=element('button','Download',this.preview);download.onclick=()=>{const url=URL.createObjectURL(new Blob([bytes]));const link=element('a');link.href=url;link.download=entry.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const binary=bytes.subarray(0,1024).includes(0);const pre=element('pre',binary?Array.from(bytes.subarray(0,256),n=>n.toString(16).padStart(2,'0')).join(' '):new TextDecoder().decode(bytes.subarray(0,64000)),this.preview);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';element('p',binary?'Binary sample: first 256 bytes':'Text sample: first 64,000 bytes',this.preview);
 }
}
registerPlugin({id:'archive-reader',name:'Archive reader',components:{archiveReader:ArchivePanel},toolbarButtons:[{label:'Archive reader',title:'Open compressed archive',menuLabel:'Archive reader (7z / RAR / compressed tar)'}],init(context){ctx=context;}});
