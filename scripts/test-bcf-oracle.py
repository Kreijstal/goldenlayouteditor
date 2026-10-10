"""Optional independent native-code oracle: python -m pip install pysam==0.23.3."""
import json, subprocess, tempfile
from pathlib import Path
import pysam
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='gle-bcf-oracle-') as temporary:
    sample = Path(temporary) / 'original.bcf'
    subprocess.run(['node', '-e', "require('node:fs').writeFileSync(process.argv[1],require('./scripts/upstream-data-fixtures').bcf())", str(sample)], cwd=root, check=True)
    with pysam.VariantFile(str(sample)) as file:
        record = next(file)
        assert record.contig == 'Original' and record.pos == 42
        assert record.info['DP'] == 7 and record.samples['OriginalSample']['GT'] == (0, 1)
    header = pysam.VariantHeader()
    header.contigs.add('Original', length=1000)
    for identifier, number, kind in [('DP',1,'Integer'),('AF','A','Float'),('LONG',1,'String'),('FLAG',0,'Flag')]:
        header.add_meta('INFO', items=[('ID',identifier),('Number',number),('Type',kind),('Description','Synthetic')])
    for identifier, number, kind in [('GT',1,'String'),('AD','R','Integer'),('TXT',1,'String')]:
        header.add_meta('FORMAT', items=[('ID',identifier),('Number',number),('Type',kind),('Description','Synthetic')])
    header.add_sample('Original'); header.add_sample('Second')
    with pysam.VariantFile(str(sample), 'wb', header=header) as file:
        record=file.new_record(contig='Original',start=41,alleles=('A','T','G'))
        record.info['DP']=70000; record.info['AF']=(0.125,None)
        record.info['LONG']='abcdefghijklmnopqr'; record.info['FLAG']=True
        record.samples['Original']['GT']=(0,1); record.samples['Original'].phased=True
        record.samples['Second']['GT']=(None,)
        record.samples['Original']['AD']=(300,2,1); record.samples['Second']['AD']=(None,None,None)
        record.samples['Original']['TXT']='Original'; record.samples['Second']['TXT']='42'
        file.write(record)
    program="import fs from 'node:fs';const {decodeBcf}=await import('data:text/javascript;base64,'+fs.readFileSync('src/imported-upstream/bcf.js').toString('base64'));console.log(JSON.stringify(await decodeBcf(fs.readFileSync(process.argv[1]))));"
    result=json.loads(subprocess.check_output(['node','--input-type=module','-e',program,str(sample)],cwd=root))
    row=result['rows'][0]
    assert row[7]=='DP=70000;AF=0.125,.;LONG=abcdefghijklmnopqr;FLAG'
    assert row[9]=='0|1:300,2,1:Original' and row[10]=='.:.,.,.:42'
print('Independent HTSlib BCF encoding/decoding oracle passed')
