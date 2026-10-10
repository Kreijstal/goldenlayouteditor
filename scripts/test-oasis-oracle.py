"""Optional independent native-format check: requires gdstk==0.9.61."""
import json
import subprocess
import tempfile
from pathlib import Path
import gdstk

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='gle-oasis-') as directory:
    folder = Path(directory)
    script = """
const fs=require('fs'),{buildSync}=require('esbuild');
const folder=process.argv[1];
buildSync({entryPoints:['src/imported-layout/oasis.ts'],outfile:folder+'/parser.cjs',bundle:true,platform:'node',format:'cjs'});
for(const flag of [true,false])fs.writeFileSync(folder+'/authored-'+flag+'.oas',require('./scripts/oasis-fixtures').fixture(flag));
"""
    subprocess.run(['node', '-e', script, directory], cwd=root, check=True)
    for flag in ('true', 'false'):
        cell = gdstk.read_oas(str(folder / f'authored-{flag}.oas')).cells[0]
        assert cell.name == 'Original42'
        assert cell.labels[0].text == '<script>safe42</script>'
        assert cell.polygons[0].layer == 1
        assert cell.polygons[0].points.tolist() == [[0, 0], [.1, 0], [.1, .1], [0, .1]]
    library = gdstk.Library(unit=1e-6, precision=1e-9)
    cell = library.new_cell('Independent42')
    cell.add(gdstk.rectangle((0, 0), (42, 20), layer=3))
    cell.add(gdstk.FlexPath([(1, 1), (20, 10)], 2, layer=4))
    cell.add(gdstk.Label('Native42', (5, 5), layer=2))
    library.write_oas(str(folder / 'independent.oas'), compression_level=6)
    script = """
const fs=require('fs'),folder=process.argv[1];
console.log(JSON.stringify(require(folder+'/parser.cjs').parseBinaryOasis(new Uint8Array(fs.readFileSync(folder+'/independent.oas')))));
"""
    model = json.loads(subprocess.check_output(['node', '-e', script, directory], cwd=root))
    assert model['cells'] == ['Independent42']
    assert model['shapes'][0]['points'] == [[0, 0], [42000, 0], [42000, 20000], [0, 20000], [0, 0]]
    assert len(model['shapes']) == 2
    assert model['labels'][0]['text'] == 'Native42'
    assert model['compressedBlockCount'] == 1
print('Native OASIS fixtures and independent compressed geometry agree with gdstk 0.9.61.')
