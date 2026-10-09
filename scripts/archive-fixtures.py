# Author tiny tar, compressed tar, raw streams, cpio and ar samples.
import io,tarfile,zipfile,bz2,lzma,gzip,zlib,struct,json,base64
content=b'hello archive <script>unsafe()</script>\n'
stream=io.BytesIO()
with tarfile.open(fileobj=stream,mode='w') as archive:
 info=tarfile.TarInfo('nested/hello.txt');info.size=len(content);archive.addfile(info,io.BytesIO(content))
tar=stream.getvalue()
stream=io.BytesIO()
with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:archive.writestr('nested/hello.txt',content)
zip_bytes=stream.getvalue()
def ar_entry(name,data):
 header=f'{name+"/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode()
 return header+data+(b'\n' if len(data)%2 else b'')
ar=b'!<arch>\n'+ar_entry('hello.txt',content)
deb=b'!<arch>\n'+ar_entry('debian-binary',b'2.0\n')+ar_entry('data.tar.xz',lzma.compress(tar))
def cpio_entry(name,data):
 values=[1,0o100644,0,0,1,0,len(data),0,0,0,0,len(name)+1,0]
 header=b'070701'+''.join(f'{n:08x}' for n in values).encode();name=name.encode()+b'\0';prefix=header+name;prefix+=b'\0'*((-len(prefix))%4);return prefix+data+b'\0'*((-len(data))%4)
cpio=cpio_entry('hello.txt',content)+cpio_entry('TRAILER!!!',b'')
toc=b'<xar><toc><file id="1"><name>hello.txt</name><type>file</type><data><length>'+str(len(content)).encode()+b'</length><offset>0</offset><size>'+str(len(content)).encode()+b'</size><encoding style="application/octet-stream"/></data></file></toc></xar>'
compressed=zlib.compress(toc);xar=struct.pack('>4sHHQQI',b'xar!',28,1,len(compressed),len(toc),0)+compressed+content
lead=struct.pack('>4sBBHH66sHH16s',bytes.fromhex('edabeedb'),3,0,0,1,b'viewer-fixture',1,5,b'')
signature=bytes.fromhex('8eade801')+bytes(12)
strings=b'';indices=[]
for tag,text in [(1000,'viewer-fixture'),(1001,'1.0'),(1002,'1'),(1021,'linux'),(1022,'noarch'),(1124,'cpio'),(1125,'gzip'),(1126,'9')]:
 indices.append(struct.pack('>IIII',tag,6,len(strings),1));strings+=text.encode()+b'\0'
header=bytes.fromhex('8eade801')+bytes(4)+struct.pack('>II',len(indices),len(strings))+b''.join(indices)+strings
rpm=lead+signature+header+gzip.compress(cpio)
fixtures={'rpm':rpm,'xar':xar,'cbt':tar,'bz2':bz2.compress(content),'xz':lzma.compress(content),'lzma':lzma.compress(content,format=lzma.FORMAT_ALONE),'gzip':gzip.compress(content),'tbz2':bz2.compress(tar),'txz':lzma.compress(tar),'ar':ar,'deb':deb,'cpio':cpio,'zipx':zip_bytes}
print(json.dumps({ext:base64.b64encode(data).decode() for ext,data in fixtures.items()}))
