"""Serve the upstream release build sources and native dependency sources."""
import concurrent.futures,gzip,json,os,pathlib,shutil,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
catalog=json.loads((root/'public/licenses/imported-viewers/media/sources.json').read_text())
cache=root/'.cache/media-sources';output=root/'public/media-viewer/source';output.mkdir(parents=True,exist_ok=True)
def run(entry):
 target=output/(entry['name']+'.tar.gz');checkout=cache/entry['name'];sha=entry['commit']
 if target.exists():return
 checkout.mkdir(parents=True,exist_ok=True)
 if not (checkout/'.git').exists():
  subprocess.run(['git','init','-q',str(checkout)],check=True)
  subprocess.run(['git','-C',str(checkout),'remote','add','origin',entry['repository']],check=True)
  subprocess.run(['git','-C',str(checkout),'fetch','-q','--depth','1','origin',sha],check=True)
  subprocess.run(['git','-C',str(checkout),'checkout','-q','--detach','FETCH_HEAD'],check=True)
 actual=subprocess.check_output(['git','-C',str(checkout),'rev-parse','HEAD'],text=True).strip()
 if actual!=sha:raise RuntimeError('Unexpected media source revision: '+entry['name'])
 temporary=target.with_suffix('.partial')
 process=subprocess.Popen(['git','-C',str(checkout),'archive','--format=tar','--prefix='+entry['name']+'-'+sha[:12]+'/',sha],stdout=subprocess.PIPE)
 with temporary.open('wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as compressed:shutil.copyfileobj(process.stdout,compressed)
 process.stdout.close()
 if process.wait()!=0:raise RuntimeError('Media source archive failed: '+entry['name'])
 temporary.replace(target);print('Media source: '+entry['name'],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:list(pool.map(run,catalog))
shutil.copyfile(root/'public/licenses/imported-viewers/media/sources.json',output/'sources.json')
for name in ['COPYING.GPLv2','COPYING.GPLv3','COPYING.LGPLv2.1','COPYING.LGPLv3','LICENSE.md']:
 shutil.copyfile(cache/'FFmpeg'/name,root/'public/licenses/imported-viewers/media'/name)
