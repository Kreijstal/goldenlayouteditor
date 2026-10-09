#!/usr/bin/env python3
"""Build Python format lists and compare sets from executable/declarative registries.

Default: refresh our claims and compare with the checked-in upstream snapshot.
--upstreams DIR: refresh upstream claims from the three sibling clones, too.
This audits declared handling, not successful rendering of every possible file.
"""
import argparse
import json
import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from re import _parser, _constants as C

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'docs/format-audit'


def finite_pattern(pattern):
    """Enumerate finite regex branches; keep unbounded/content patterns separately."""
    incomplete = False
    def expand(tokens):
        nonlocal incomplete
        result = {''}
        for op, arg in tokens:
            values = set()
            if op == C.LITERAL:
                values = {chr(arg)}
            elif op == C.AT:
                values = {''}
            elif op == C.SUBPATTERN:
                values = expand(arg[-1])
            elif op == C.BRANCH:
                for branch in arg[1]:
                    values |= expand(branch)
            elif op == C.IN:
                for kind, item in arg:
                    if kind == C.LITERAL:
                        values.add(chr(item))
                    elif kind == C.RANGE:
                        values.update(chr(i) for i in range(item[0], item[1] + 1))
                    elif kind == C.CATEGORY and item == C.CATEGORY_DIGIT:
                        values.update('0123456789')
                    else:
                        incomplete = True
            elif op in (C.MAX_REPEAT, C.MIN_REPEAT) and arg[1] != C.MAXREPEAT and arg[1] <= 3:
                items = expand(arg[2])
                for count in range(arg[0], arg[1] + 1):
                    repeated = {''}
                    for _ in range(count):
                        repeated = {a + b for a in repeated for b in items}
                    values |= repeated
            else:
                incomplete = True
                return set()
            result = {a + b for a in result for b in values}
            if len(result) > 10000:
                raise ValueError('Unexpectedly large extension expression: ' + pattern)
        return result
    expanded = expand(_parser.parse(pattern, 0))
    extensions = {name[1:].lower() for name in expanded if re.fullmatch(r'\.[A-Za-z0-9_+.-]+', name)}
    filenames = {name.lower() for name in expanded if name and not name.startswith('.') and re.fullmatch(r'[A-Za-z0-9_+.-]+', name)}
    return extensions, filenames, incomplete


def normalize(extension):
    return extension.lower().lstrip('.')


def upstream_ts(directory):
    facts = []
    fly = directory / 'flyfish-file-viewer'
    file = fly / 'packages/core/src/registry/formats.generated.ts'
    source = file.read_text()
    definitions = json.loads(source.split('export const DEFAULT_RENDERER_DEFINITIONS = ', 1)[1].split(' as const satisfies', 1)[0].rstrip(';\n '))
    for definition in definitions:
        if definition['id']=='code':
            generic = dict(project='flyfish',owner='code',kind='generic-text',source=os.path.relpath(file,ROOT),line=1,extensions=[ext for ext in definition['extensions'] if ext not in ('bundle','lrc','html','htm')],filenames=[])
            facts.append(generic)
            definition={**definition,'extensions':[ext for ext in definition['extensions'] if ext in ('bundle','lrc','html','htm')]}
        facts.append(dict(project='flyfish', owner=definition['id'], kind='viewer', source=os.path.relpath(file,ROOT), line=1,
                          extensions=definition['extensions'], filenames=[], status=definition['status'], support_level=definition['supportLevel'], known_limits=definition.get('knownLimits', [])))
    op = directory / 'open-file-viewer'
    for file in sorted((op / 'packages/core/src/plugins').glob('*.ts')):
        if '.test.' in file.name:
            continue
        source = file.read_text()
        for match in re.finditer(r'const\s+(\w*[Ee]xtensions)\s*=\s*new Set\(\[([\s\S]*?)\]\)', source):
            if match[1] in ('textLikeExtensions','nonRasterImageExtensions'):
                continue
            facts.append(dict(project='open-file-viewer',owner=file.stem,kind='viewer',source=os.path.relpath(file,ROOT),line=source[:match.start()].count('\n')+1,
                              extensions=re.findall(r'["\']([a-z0-9_.+-]+)["\']',match[2]),filenames=[]))
        for map_name, kind in [('langMap','generic-text'),('filenameLangMap','generic-text-filename')]:
            match = re.search(r'const '+map_name+r'[^=]*=\s*\{([\s\S]*?)\n\};',source)
            if match:
                names = re.findall(r'^\s*(?:["\']([^"\']+)["\']|(\w+))\s*:', match[1], re.M)
                values = [a or b for a,b in names]
                facts.append(dict(project='open-file-viewer',owner=file.stem,kind=kind,source=os.path.relpath(file,ROOT),line=source[:match.start()].count('\n')+1,
                                  extensions=values if kind=='generic-text' else [],filenames=values if kind.endswith('filename') else []))
    # The matrix is upstream's own regression contract, including aliases not in a Set.
    file = op / 'packages/core/src/plugins/format-matrix.test.ts'
    source = file.read_text().split('const matrix: FormatCase[] = [',1)[1].split('\n];',1)[0]
    for match in re.finditer(r'plugin:\s*(\w+)Plugin\([\s\S]*?extensions:\s*\[([^\]]*)\]',source):
        facts.append(dict(project='open-file-viewer',owner=match[1],kind='generic-text' if match[1]=='text' else 'viewer',source=os.path.relpath(file,ROOT),line=1,
                          extensions=re.findall(r'"([a-z0-9_.+-]+)"',match[2]),filenames=[]))
    return facts


def run(upstreams=None):
    command = ['node',str(ROOT / 'scripts/format-audit-extract.js')]
    if upstreams:
        command.append(str(upstreams))
    extracted = json.loads(subprocess.check_output(command, text=True))
    if extracted['diagnostics']:
        raise ValueError(extracted['diagnostics'])
    ours = [fact for fact in extracted['facts'] if fact['project']=='ours']
    DATA.mkdir(exist_ok=True,parents=True)
    snapshot = DATA / 'upstreams.json'
    if upstreams:
        upstream = [fact for fact in extracted['facts'] if fact['project']!='ours'] + upstream_ts(upstreams)
        revisions = {}
        for name in ['jdeworks-file-viewer','open-file-viewer','flyfish-file-viewer']:
            revisions[name] = subprocess.check_output(['git','-C',str(upstreams/name),'rev-parse','HEAD'],text=True).strip()
        snapshot.write_text(json.dumps(dict(revisions=revisions,facts=upstream),indent=2)+'\n')
    reference = json.loads(snapshot.read_text())
    upstream = reference['facts']
    all_facts = ours + upstream
    unbounded = []
    for fact in all_facts:
        if 'pattern' in fact:
            extensions, filenames, incomplete = finite_pattern(fact['pattern'])
            fact['extensions'] = sorted(set(fact['extensions']) | extensions)
            fact['filenames'] = sorted(set(fact['filenames']) | filenames)
            if incomplete:
                unbounded.append(dict(project=fact['project'],owner=fact['owner'],pattern=fact['pattern'],source=fact['source'],line=fact['line']))
        fact['extensions'] = sorted({normalize(ext) for ext in fact['extensions']})
    candidates = sorted({ext for fact in all_facts if fact['kind'] not in ('detection-only','enhancement') for ext in fact['extensions']})
    # Use JavaScript for JS regex semantics, including lookarounds/anchors/flags.
    probe = "const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(x.patterns.map(p=>x.candidates.filter(e=>new RegExp(p.pattern,p.flags).test('sample.'+e)))));"
    patterns = [fact for fact in all_facts if 'pattern' in fact]
    matches = json.loads(subprocess.check_output(['node','-e',probe],input=json.dumps(dict(patterns=patterns,candidates=candidates)),text=True))
    for fact, matched in zip(patterns,matches):
        fact['extensions'] = sorted(set(fact['extensions']) | set(matched))
    # Explicit content-selected ELF handling: the /^/ route needs magic, not an extension.
    elf = next(fact for fact in ours if fact['kind']=='magic' and fact['owner']=='elfViewer')
    elf['extensions'] = ['elf','so','o','out','debug','axf']
    elf['condition'] = 'ELF magic required; arbitrary extensions or no suffix are also accepted'
    # Python lists, followed by the actual set operations requested.
    for fact in upstream:
        if fact['project']=='jdeworks' and fact['owner'] in ('text/raw','text/code','text/log'):
            fact['kind']='generic-text'
    our_formats = sorted({ext for fact in ours for ext in fact['extensions']})
    their_formats = sorted({ext for fact in upstream if fact['kind'] not in ('detection-only','enhancement','generic-text','generic-text-filename') for ext in fact['extensions']})
    ours_set = set(our_formats)
    theirs_set = set(their_formats)
    missing = sorted(theirs_set - ours_set)
    shared = sorted(theirs_set & ours_set)
    ours_only = sorted(ours_set - theirs_set)
    declared_text = sorted({ext for fact in upstream if fact['kind']=='generic-text' for ext in fact['extensions']})
    # Generic editor can show any decoded text; syntax registries are not dedicated parsers.
    text_only = sorted(set(declared_text) - ours_set)
    missing_by_project = {project:sorted({ext for fact in upstream if fact['project']==project and fact['kind'] not in ('detection-only','enhancement','generic-text','generic-text-filename') for ext in fact['extensions']} - ours_set)
                          for project in sorted({f['project'] for f in upstream})}
    owners = defaultdict(list)
    for fact in upstream:
        if fact['kind'] not in ('detection-only','enhancement','generic-text','generic-text-filename'):
            for ext in fact['extensions']:
                item = dict(project=fact['project'],owner=fact['owner'],source=fact['source'],line=fact['line'])
                if item not in owners[ext]:
                    owners[ext].append(item)
    shared_capability_gaps = [
        dict(extension='3mf',ours='ZIP container browsing',missing='3D Manufacturing model rendering'),
        dict(extension='kmz',ours='ZIP container browsing',missing='KML/geospatial or embedded model preview'),
        dict(extension='hdr',ours='Radiance/HDR image',missing='NIfTI/ANALYZE medical-volume header'),
        dict(extension='img',ours='disk image / game input',missing='NIfTI/ANALYZE medical-volume image'),
        dict(extension='md',ours='generic text / binary Mega Drive ROM',missing='dedicated rendered Markdown preview; manual Pandoc conversion exists'),
        dict(extension='vcf',ours='vCard contacts when BEGIN:VCARD matches',missing='genomic Variant Call Format inspection'),
        dict(extension='asc',ours='OpenPGP-encrypted message decryption',missing='detached signature/certificate inspection'),
        dict(extension='gpg',ours='OpenPGP-encrypted message decryption',missing='signature verification and signed-container inspection'),
        dict(extension='pgp',ours='OpenPGP-encrypted message decryption',missing='signature verification and signed-container inspection'),
        dict(extension='json',ours='source / Lottie',missing='other structured data and schema-specific summaries'),
        dict(extension='xml',ours='source / MathML / MusicXML',missing='other XML domain-specific summaries'),
    ]
    report = dict(revisions=reference['revisions'],our_formats=our_formats,their_formats=their_formats,missing=missing,shared=shared,ours_only=ours_only,
                  upstream_text_extensions_without_a_dedicated_viewer=text_only,missing_by_project=missing_by_project,
                  missing_evidence={ext:owners[ext] for ext in missing},our_evidence=ours,
                  shared_capability_gaps=shared_capability_gaps,upstream_named_files=[fact for fact in upstream if fact['filenames'] and fact['kind']!='enhancement'],
                  upstream_content_only_formats=[fact for fact in upstream if fact['kind']=='content-only'],
                  nonfinite_patterns=unbounded,enhancements=[fact for fact in upstream if fact['kind']=='enhancement'])
    (DATA/'comparison.json').write_text(json.dumps(report,indent=2)+'\n')
    (DATA/'formats.py').write_text('# Generated by scripts/audit-viewer-formats.py; refresh instead of editing.\n'
                                  +'OUR_FORMATS = '+repr(our_formats)+'\n\nTHEIR_FORMATS = '+repr(their_formats)+'\n\n'
                                  +'MISSING = sorted(set(THEIR_FORMATS) - set(OUR_FORMATS))\n'
                                  +'SHARED = sorted(set(THEIR_FORMATS) & set(OUR_FORMATS))\n'
                                  +'OURS_ONLY = sorted(set(OUR_FORMATS) - set(THEIR_FORMATS))\n')
    rows = ['# Viewer format audit','',
            'Generated from registered source claims, not README examples. This compares filename extensions; it does not prove renderer fidelity. A generic text/hex view does not count as a format-specific viewer. The upstream snapshots retain owners and source locations.','',
            f'Our explicit viewer/native/archive handling: **{len(our_formats)}** suffixes. Upstream non-generic claims: **{len(their_formats)}**. Shared: **{len(shared)}**. Missing suffixes: **{len(missing)}**.','',
            '## Missing extensions','', '| Extension | Upstream handlers |','| --- | --- |']
    for ext in missing:
        handlers = sorted({f"{entry['project']}: {entry['owner']}" for entry in owners[ext]})
        rows.append(f"| `.{ext}` | {', '.join(handlers)} |")
    rows += ['', '## Shared suffixes with missing capabilities', '', '| Suffix | Current handling | Missing capability |', '| --- | --- | --- |']
    rows += [f"| `.{gap['extension']}` | {gap['ours']} | {gap['missing']} |" for gap in shared_capability_gaps]
    rows += ['', 'This table records reviewed collisions, not a complete fidelity comparison for every shared suffix.', '', '## Scope and collisions','',
             '- `.bundle` is a Git bundle in Flyfish. jdeworks also names `.bundle` in its Mach-O signature metadata; that detection-only catalog is retained in the snapshot but excluded from renderer claims.',
             '- Extension equality is a first pass, not semantic equivalence. `.3mf` and `.kmz` can be browsed as ZIP containers here, but that is not a 3D/geo renderer; `.bin`, `.img`, `.md`, `.xml`, `.json`, `.vcf`, `.ics`, `.art` and other reused suffixes need header/schema checks.',
             '- Media metadata handling is counted but does not imply playable audio/video. Imported/converted/embedded-preview support is not native editing.',
             '- Filename regex families and content/magic detectors cannot be completely expressed as a finite extension list; their source expressions are preserved in comparison.json.',
             '- Plain-text display is available independently of suffix, so `.txt`, `.yaml`, `.ini`, etc. in the gap list mean missing upstream structured/domain-specific views, not unreadable text.\n- Upstream generic code-language suffixes are reported separately; our generic editor can display text without having a dedicated parser.',
             f"- jdeworks has **{len(report['enhancements'])}** registered filename/schema enhancements. These are separately inventoried in comparison.json; sharing `.json`, `.yaml`, `.xml`, etc. does not mean we implement these structured summaries.",
             '- Upstream experimental, metadata and external-tool claims are included with their original status/support limits in upstreams.json. This is a gap inventory, not an assertion that each can be copied into a browser and render faithfully.',
             '', '## Reproduce','', '```sh','python scripts/audit-viewer-formats.py',
             '# Refresh the upstream snapshot from sibling clones:', 'python scripts/audit-viewer-formats.py --upstreams ..','```','',
             'The concrete Python lists and set difference are in formats.py; comparison.json includes the full evidence and per-project differences.','', '## Revisions','']
    rows += [f'- `{name}`: `{sha}`' for name,sha in reference['revisions'].items()]
    (DATA/'README.md').write_text('\n'.join(rows)+'\n')
    print(json.dumps(dict(ours=len(our_formats),theirs=len(their_formats),missing=len(missing),shared=len(shared),enhancements=len(report['enhancements']),missing_extensions=missing,nonfinite_patterns=len(unbounded)),indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstreams',type=Path)
    options = parser.parse_args()
    run(options.upstreams.resolve() if options.upstreams else None)
