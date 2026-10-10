"""Original EOT container writer wrapping the already licensed DejaVu font."""
import struct, sys
from pathlib import Path
from fontTools.ttLib import TTFont
font_path=Path(__file__).resolve().parents[1]/'public/typst-viewer/fonts/DejaVuSansMono.ttf'
font=TTFont(font_path);data=font_path.read_bytes();os2=font['OS/2'];name=font['name']
header=bytearray(80)
struct.pack_into('<III',header,4,len(data),0x20001,0x80)
header[16:26]=bytes(getattr(os2.panose,key) for key in ['bFamilyType','bSerifStyle','bWeight','bProportion','bContrast','bStrokeVariation','bArmStyle','bLetterForm','bMidline','bXHeight'])
header[26]=1;header[27]=os2.fsSelection&1
struct.pack_into('<IHH',header,28,os2.usWeightClass,os2.fsType,0x504c)
struct.pack_into('<4I',header,36,os2.ulUnicodeRange1,os2.ulUnicodeRange2,os2.ulUnicodeRange3,os2.ulUnicodeRange4)
struct.pack_into('<2I',header,52,os2.ulCodePageRange1,os2.ulCodePageRange2)
struct.pack_into('<I',header,60,font['head'].checkSumAdjustment)
for name_id in [1,2,5,4]:
 record=name.getName(name_id,3,1,0x409);value=record.toUnicode().encode('utf-16le')
 header+=struct.pack('<HH',0,len(value))+value
header+=struct.pack('<HH',0,0)
struct.pack_into('<I',header,0,len(header)+len(data))
sys.stdout.buffer.write(header+data)
