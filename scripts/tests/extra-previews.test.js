const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAco, parseAbr } = require('../../src/adobe-resources');
const { isAbcText, isAcfText, isExtraTextFile, parseKeyValues, protobufFields, parseAndroidManifest } = require('../../src/extra-file-data');
const fixtures = require('./extra-preview-fixtures');
const { validateMedia } = require('../../src/legacy-media-plugin');
const { safeEntryPath } = require('../../src/container-preview-plugin');
const { parseSevenZipList } = require('../../public/sevenzip-list');

test('ACO version 2 names override version 1 colors and RGB/gray values are rendered', () => {
    const palette = parseAco(fixtures.palette());
    assert.equal(palette.version, 2); assert.equal(palette.colors.length, 3);
    assert.equal(palette.colors[0].hex, '#ff0000'); assert.equal(palette.colors[1].hex, '#808080');
    assert.equal(palette.colors[2].name, '<img src=x onerror=alert(1)>');
    assert.throws(() => parseAco(fixtures.palette().subarray(0, 17)), /Truncated/);
});

test('ABR legacy raw and modern PackBits masks decode to the same brush tip', () => {
    for (const version of [1, 2, 6]) {
        const library = parseAbr(fixtures.brushes(version));
        assert.equal(library.brushes.length, 1);
        assert.equal(library.brushes[0].width, 2); assert.equal(library.brushes[0].height, 2);
        assert.deepEqual([...library.brushes[0].pixels], [0,64,128,255]);
    }
    assert.throws(() => parseAbr(fixtures.brushes().subarray(0, 40)), /Truncated/);
});

test('music, Steam and Ableton reused suffixes require recognizable content', () => {
    assert.equal(isAbcText(fixtures.abc), true); assert.equal(isAbcText('Alembic model'), false);
    assert.equal(isAcfText(fixtures.steam), true); assert.equal(isAcfText('Aircraft file'), false);
    assert.equal(isExtraTextFile({ name: 'model.abc', content: 'Ogawa\0' }), false);
    assert.equal(isExtraTextFile({ name: 'alloy.als', content: 'sig Foo {}' }), false);
    assert.equal(isExtraTextFile({ name: 'set.als', head: Uint8Array.from([31,139]) }), true);
});

test('Steam KeyValues retains nested and duplicate values and rejects malformed blocks', () => {
    const manifest = parseKeyValues(fixtures.steam);
    assert.equal(manifest.summary.appid, '123'); assert.equal(manifest.summary.name, 'Steam fixture');
    const duplicate = parseKeyValues('"AppState" { "name" "a" "name" "b" }');
    assert.equal(duplicate.tree[0].value.length, 2);
    assert.throws(() => parseKeyValues('"AppState" { "name" "abc"'), /Unclosed/);
    assert.throws(() => parseKeyValues('"Other" { "name" "abc" }'), /AppState/);
});

test('AAPT2 protobuf XML manifest inspection extracts package and permissions', () => {
    const manifest = parseAndroidManifest(fixtures.androidManifest());
    assert.equal(manifest.package, 'org.example.preview'); assert.equal(manifest.versionName, '1.2.3');
    assert.deepEqual(manifest.permissions, ['android.permission.INTERNET']);
    assert.throws(() => protobufFields(Buffer.from([10,100,1])), /Truncated/);
    assert.throws(() => parseAndroidManifest(fixtures.pb(1, fixtures.pb(3, 'wrong'))), /manifest/);
});

test('7-Zip technical listings retain files and exclude folders/links', () => {
    const text = 'Path = folder\nSize = 0\nAttributes = D drwxr-xr-x\n\nPath = folder/a.txt\nSize = 20\nAttributes = A -rw-r--r--\nEncrypted = +\n\nPath = link\nSize = 0\nSymbolic Link = target\n';
    assert.deepEqual(parseSevenZipList(text), [{ path: 'folder/a.txt', size: 20, encrypted: true }]);
    assert.equal(safeEntryPath('folder/a.txt'), 'folder/a.txt');
    for (const path of ['../secret', '/secret', '\\secret', 'C:\\secret', 'a/../b']) assert.throws(() => safeEntryPath(path), /Unsafe/);
});

test('legacy audio and 3GPP2 media use matching magic rather than suffix alone', () => {
    assert.equal(validateMedia(Buffer.from('#!AMR\n'), 'audio.amr'), true);
    assert.equal(validateMedia(Buffer.from('FORMxxxxAIFF'), 'audio.aif'), true);
    assert.equal(validateMedia(Buffer.from('FORMxxxxAIFC'), 'audio.aifc'), true);
    assert.equal(validateMedia(Buffer.from('xxxxftyp3g2a'), 'video.3g2'), true);
    assert.equal(validateMedia(Buffer.from('xxxxftypisom'), 'video.3g2'), false);
    assert.equal(validateMedia(Buffer.from('FORMxxxxAIFF'), 'audio.amr'), false);
});
