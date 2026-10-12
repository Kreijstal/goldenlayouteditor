const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const unicode = s => { const text = Buffer.from(s + '\0', 'utf16le'); text.swap16(); return Buffer.concat([u32(s.length + 1), text]); };
function palette() {
    const colors = [[0, [65535,0,0,0], 'Red fixture'], [8, [5000,0,0,0], 'Gray fixture'], [0, [0,65535,0,0], '<img src=x onerror=alert(1)>']];
    const group = version => Buffer.concat([u16(version), u16(colors.length), ...colors.map(([space, values, name]) => Buffer.concat([u16(space), ...values.map(u16), ...(version === 2 ? [unicode(name)] : [])]))]);
    return Buffer.concat([group(1), group(2)]);
}
function brushes(version = 6) {
    const bounds = Buffer.concat([i32(0), i32(0), i32(2), i32(2)]);
    if (version === 1 || version === 2) {
        const sample = Buffer.concat([u32(0), u16(25), ...(version === 2 ? [unicode('Sample tip')] : []), Buffer.alloc(9), bounds, u16(8), Buffer.from([0,0,64,128,255])]);
        return Buffer.concat([u16(version), u16(1), u16(2), u32(sample.length), sample]);
    }
    const sample = Buffer.concat([Buffer.from([36]), Buffer.from('12345678-1234-1234-1234-123456789012'), Buffer.alloc(10), bounds, u16(8), Buffer.from([1]), u16(3), u16(3), Buffer.from([1,0,64,1,128,255])]);
    const data = Buffer.concat([u32(sample.length), sample, Buffer.alloc((4 - sample.length % 4) % 4)]);
    return Buffer.concat([u16(6), u16(1), Buffer.from('8BIMsamp'), u32(data.length), data]);
}
function varint(n) { const bytes = []; do { const low = n % 128; n = Math.floor(n / 128); bytes.push(low | (n ? 128 : 0)); } while (n); return Buffer.from(bytes); }
function pb(field, value) {
    if (typeof value === 'number') return Buffer.concat([varint(field * 8), varint(value)]);
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
const attr = (name, value) => pb(4, Buffer.concat([pb(2, name), pb(3, value)]));
function androidManifest() {
    const permission = pb(1, Buffer.concat([pb(3, 'uses-permission'), attr('name', 'android.permission.INTERNET')]));
    return pb(1, Buffer.concat([pb(3, 'manifest'), attr('package', 'org.example.preview'), attr('versionName', '1.2.3'), pb(5, permission)]));
}
function miniPdf() {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const stream = 'BT /F1 16 Tf 20 100 Td (Illustrator template fixture) Tj ET';
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${o}\nendobj\n`; });
    const start = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10,'0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(pdf);
}
const steam = '"AppState"\n{\n "appid" "123"\n "name" "Steam fixture"\n "installdir" "Fixture"\n "buildid" "456"\n "InstalledDepots" { "100" { "manifest" "789" } }\n}\n';
const ableton = '<?xml version="1.0"?><Ableton MajorVersion="5" Creator="Ableton Live fixture"><LiveSet><MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="120"/></Tempo></Mixer></DeviceChain></MasterTrack><Tracks><MidiTrack><Name><EffectiveName Value="Piano fixture"/></Name><DeviceChain><Devices><InstrumentVector/></Devices></DeviceChain><MidiClip><Name Value="Clip fixture"/><CurrentStart Value="0"/><CurrentEnd Value="4"/></MidiClip></MidiTrack></Tracks></LiveSet></Ableton>';
const abc = 'X:1\nT:First fixture\nM:4/4\nL:1/4\nK:C\nC D E F | G A B c |\n\nX:2\nT:Second fixture\nM:3/4\nL:1/4\nK:G\nG A B | c d e |\n';
module.exports = { palette, brushes, pb, androidManifest, miniPdf, steam, ableton, abc };
