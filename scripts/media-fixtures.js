// Fixtures are generated from a red frame and a sine wave, never user media.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
function fixtures(){const dir=process.env.TEST_MEDIA_FIXTURE_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'gle-media-'));const result={};
 const audio={aif:['pcm_s16be','aiff'],aiff:['pcm_s16be','aiff'],aifc:['pcm_f32be','aiff'],au:['pcm_s16be','au'],snd:['pcm_s16be','au'],caf:['pcm_s16le','caf'],oga:['libvorbis','ogg'],weba:['libopus','webm'],m4b:['aac','ipod'],wma:['wmav2','asf']};
 const video={asf:['wmv2','asf'],divx:['mpeg4','avi','-vtag','DX50'],f4v:['libx264','f4v'],flv:['flv','flv'],m2v:['mpeg2video','mpeg2video'],mpe:['mpeg1video','mpeg'],mpv:['mpeg1video','mpeg1video'],rm:['rv20','rm'],rmvb:['rv20','rm'],vob:['mpeg2video','vob'],'3g2':['mpeg4','3g2']};
 for(const [ext,[codec,format,...extra]] of Object.entries({...audio,...video})){const target=path.join(dir,'original.'+ext);if(!fs.existsSync(target)){const source=audio[ext]?'sine=frequency=440:sample_rate=44100:duration=0.4':'color=c=red:size=64x48:rate=25:duration=0.4';execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',source,'-threads','1',audio[ext]?'-c:a':'-c:v',codec,...extra,'-f',format,target],{stdio:'pipe'});}result[ext]=fs.readFileSync(target);}
 const amr=path.join(dir,'original.amr');if(!fs.existsSync(amr))fs.writeFileSync(amr,Buffer.concat([Buffer.from('#!AMR\n'),...Array.from({length:20},()=>Buffer.concat([Buffer.from([0x3c]),Buffer.alloc(31)]))]));result.amr=fs.readFileSync(amr);return result;
}
module.exports={fixtures};
