"""Native LRX2 atom/metadata fixtures, checked against the original calibre oracle."""
import base64,io,json,struct,sys,types,importlib.util,xml.etree.ElementTree as ET
from pathlib import Path
spec=importlib.util.spec_from_file_location('original_lrf_fixture',Path(__file__).with_name('lrf-fixtures.py'));fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
xml='<Info><BookInfo><Title reading="Original title">Original42 &lt;script&gt;window.userExecuted=1&lt;/script&gt;</Title><Author reading="Native writer">Native Writer</Author><Publisher>Original Publisher</Publisher><Category>Native42</Category></BookInfo><DocInfo><Language>en</Language></DocInfo></Info>'
payload=fixture.fixture(xml)
def atom(kind,data,extended=False):return (struct.pack('>I4sQ',1,kind,16+len(data)) if extended else struct.pack('>I4s',8+len(data),kind))+data
brand=atom(b'ftyp',b'LRX2'+struct.pack('>I',0)),
brand=brand[0]
normal=brand+atom(b'free',b'Original native opaque atom')+atom(b'bbeb',payload)
extended=brand+atom(b'bbeb',payload,True)
# Supply only calibre's metadata DTO/XML helpers; execute its unmodified binary parser.
class Metadata:
    def __init__(self,title,authors):self.title,self.authors=title,authors
for name in ['calibre','calibre.ebooks','calibre.ebooks.metadata','calibre.utils','calibre.utils.xml_parse']:sys.modules[name]=types.ModuleType(name)
sys.modules['calibre.ebooks.metadata'].MetaInformation=Metadata
sys.modules['calibre.ebooks.metadata'].string_to_authors=lambda s:[s]
sys.modules['calibre.utils.xml_parse'].safe_xml_fromstring=ET.fromstring
spec=importlib.util.spec_from_file_location('native_lrx_oracle',Path(__file__).parent/'native-lrx-oracle/metadata.py');oracle=importlib.util.module_from_spec(spec);spec.loader.exec_module(oracle)
result=oracle.get_metadata(io.BytesIO(normal));assert result.title=='Original42 <script>window.userExecuted=1</script>' and result.authors==['Native Writer'] and result.publisher=='Original Publisher' and result.language=='en' and result.tags==['Native42']
print(json.dumps({'lrx':base64.b64encode(normal).decode(),'extended.lrx':base64.b64encode(extended).decode()}))
