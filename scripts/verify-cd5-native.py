#!/usr/bin/env python3
"""Optional comparison with original x86 routines; no vendor code is distributed.
python -m pip install unicorn
python scripts/verify-cd5-native.py /path/chp_Editor.exe /tmp/vectors.ndjson
"""
from pathlib import Path
import base64, hashlib, json, struct, sys
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EIP, UC_X86_REG_ESP
editor, vectors = map(Path, sys.argv[1:])
pe = editor.read_bytes()
assert hashlib.sha256(pe).hexdigest() == 'fc77911c75cbb27cb3d0141a19d16c6c43fbf2fb1f851b96a271b7b504dc34c3', 'wrong Editor build'
u = Uc(UC_ARCH_X86, UC_MODE_32)
h = struct.unpack_from('<I', pe, 0x3c)[0]
n = struct.unpack_from('<H', pe, h+6)[0]
opt = struct.unpack_from('<H', pe, h+20)[0]
size = struct.unpack_from('<I', pe, h+24+56)[0]
u.mem_map(0x400000, (size+4095)&~4095)
for i in range(n):
    p = h+24+opt+i*40
    vs, va, rs, rp = struct.unpack_from('<IIII', pe, p+8)
    u.mem_write(0x400000+va, pe[rp:rp+rs])
SRC, DST, STACK, STOP = 0x2000000, 0x2200000, 0x2400000, 0x2500000
for address, size in [(SRC,0x200000),(DST,0x200000),(STACK,0x10000),(STOP,0x1000)]:
    u.mem_map(address,size)
functions = {1:0x456850,2:0x456bf0,6:0x457220,7:0x456f30,8:0x457610}
counts = {'kernel':0,'profile':0}
for line in vectors.read_text().splitlines():
    v = json.loads(line)
    src, expected = (base64.b64decode(v[k]) for k in ('src','out'))
    assert len(src)+4 < 0x200000 and len(expected)+16 < 0x200000
    u.mem_write(SRC, src+b'\0'*4)
    sp = STACK+0x8000
    if v['type'] == 'kernel':
        cap = v['capacity']
        assert cap+16 < 0x200000
        u.mem_write(DST,b'\0'*(cap+16))
        u.mem_write(sp,struct.pack('<IIII',STOP,SRC,len(src),0))
        u.reg_write(UC_X86_REG_ECX,DST); u.reg_write(UC_X86_REG_EDX,cap)
        entry = functions[v['id']]
    else:
        n = v['width']*v['height']
        assert n*4+16 < 0x200000
        u.mem_write(DST,b'\0'*(n*4+16))
        desc, palette = STACK+0x100, STACK+0x1000
        u.mem_write(desc,struct.pack('<IIII',v['width'],v['height'],v['width'],DST))
        u.mem_write(sp,struct.pack('<IIIIII',STOP,v['profile'],v['channels'],palette,0,0))
        u.reg_write(UC_X86_REG_ECX,desc);u.reg_write(UC_X86_REG_EDX,SRC)
        entry = 0x44ed00
    u.reg_write(UC_X86_REG_ESP,sp)
    u.emu_start(entry,STOP,count=30000000)
    assert u.reg_read(UC_X86_REG_EIP)==STOP, 'native instruction limit reached'
    length = u.reg_read(UC_X86_REG_EAX) if v['type']=='kernel' else n*4
    result = bytearray(u.mem_read(DST,length))
    if v['type']=='profile':
        for i in range(n):
            result[4*i],result[4*i+2] = result[4*i+2],result[4*i]
            if (v['profile'] in (0,5) and v['channels']==3) or (v['profile']==1 and v['channels']==1):
                result[4*i+3] = 255
    assert result==expected, f"native mismatch: {v['type']}, {v['file']}"
    counts[v['type']] += 1
print('PASS: native x86 differential comparisons', counts)
