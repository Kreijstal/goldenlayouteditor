const {registerPlugin}=require('./plugins');const {resolveAssetUrl}=require('./lazy-viewers');const {ImportedViewerPanel,element,card,details}=require('./imported-viewer-panel');let ctx;
const AUDIO=/\.(aif|aifc|aiff|amr|au|caf|snd|oga|weba|m4b|wma)$/i;
async function decode(bytes,name,signal){
 if(bytes.length>64*1024*1024)throw Error('Media input exceeds 64 MiB');
 const {FFmpeg}=await import(resolveAssetUrl('media-viewer/wrapper/index.js'));if(signal.aborted)return {cancelled:true};
 const ffmpeg=new FFmpeg(),logs=[];ffmpeg.on('log',({message})=>{logs.push(message);if(logs.length>30)logs.shift();});
 const abort=()=>ffmpeg.terminate();signal.addEventListener('abort',abort,{once:true});let deadline=false;const timer=setTimeout(()=>{deadline=true;ffmpeg.terminate();},60000);
 try{
  await ffmpeg.load({coreURL:resolveAssetUrl('media-viewer/core/ffmpeg-core.js'),wasmURL:resolveAssetUrl('media-viewer/core/ffmpeg-core.wasm')},{signal});
  const input='input.'+name.split('.').pop().toLowerCase();await ffmpeg.writeFile(input,bytes.slice());
  let status=await ffmpeg.ffprobe(['-protocol_whitelist','file,pipe','-v','error','-show_streams','-show_format','-of','json','-o','probe.json',input]);if(status!==0)throw Error('Media probe failed ('+status+'): '+logs.slice(-6).join('\n'));
  const info=JSON.parse(new TextDecoder().decode(await ffmpeg.readFile('probe.json')));const audio=AUDIO.test(name);if(!info.streams?.some(s=>s.codec_type===(audio?'audio':'video')))throw Error('No '+(audio?'audio':'video')+' stream in '+name);
  const output=audio?'preview.wav':'preview.mp4';const options=audio?['-map','0:a:0','-vn','-ac','2','-ar','44100','-c:a','pcm_s16le']:['-map','0:v:0','-map','0:a:0?','-vf',"scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-r','15','-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart'];
  status=await ffmpeg.exec(['-protocol_whitelist','file,pipe','-i',input,'-t','30',...options,output],50000);if(status!==0)throw Error('Media decoder failed: '+logs.slice(-6).join('\n'));
  const data=await ffmpeg.readFile(output);if(data.length>64*1024*1024)throw Error('Media preview exceeds 64 MiB');
  return {data,info,audio,mime:audio?'audio/wav':'video/mp4',summary:'Local decoded '+(audio?'audio':'video')+' preview'};
 }catch(error){if(signal.aborted)return {cancelled:true};if(deadline)throw Error('Media preview exceeded 60 seconds');throw error instanceof Error?error:Error(String(error));}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);ffmpeg.terminate();}
}
class MediaCodecPanel extends ImportedViewerPanel{
 constructor(container,state){const active={controller:new AbortController()};container.on('destroy',()=>active.controller.abort());super(container,state,ctx,{accept:'.aif,.aifc,.aiff,.amr,.au,.caf,.snd,.oga,.weba,.m4b,.wma,.asf,.divx,.f4v,.flv,.m2v,.mpe,.mpv,.rm,.rmvb,.vob,.3g2,.ogv',parse:bytes=>decode(bytes,'input.asf',active.controller.signal),render(model,host){const box=card(host,'Decoded media preview');details(box,'Preview limits','First 30 seconds; video at up to 960×540 and 15 frames/s. Source codecs and streams are listed below.');const player=element(model.audio?'audio':'video',undefined,box);player.controls=true;player.preload='auto';player.style.cssText='max-width:100%;display:block';const url=URL.createObjectURL(new Blob([model.data],{type:model.mime}));player.src=url;const meta=element('details',undefined,box);element('summary','Native stream metadata',meta);element('pre',JSON.stringify(model.info,null,2),meta);return {destroy(){player.pause();player.removeAttribute('src');player.load();URL.revokeObjectURL(url);}};}});this.active=active;}
 async show(bytes,name){this.active.controller.abort();this.active.controller=new AbortController();this.options.parse=bytes=>decode(bytes,name,this.active.controller.signal);return super.show(bytes,name);}
}
registerPlugin({id:'media-codecs',name:'Media codecs',components:{mediaCodecViewer:MediaCodecPanel},toolbarButtons:[{label:'Media codecs',title:'Decode audio or video locally',menuLabel:'Media codecs'}],init(context){ctx=context;}});
