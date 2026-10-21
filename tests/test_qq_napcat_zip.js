'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { extractZipArchive, inspectZipArchive, parseZip32 } = require('../services/home-node/qq-napcat-zip.js');
const { validateNodeBundle } = require('../services/home-node/qq-napcat-manager.js');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(input) {
  let value = 0xffffffff;
  for (const byte of input) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const packed = entry.directory ? Buffer.alloc(0) : zlib.deflateRawSync(data);
    const crc = entry.directory ? 0 : crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(packed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([localHeader, name, packed]);
    local.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(packed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(entry.externalAttributes || 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([centralHeader, name]));
    localOffset += localRecord.length;
  }
  const centralBytes = Buffer.concat(central);
  const localBytes = Buffer.concat(local);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function makePeX64Stub() {
  const data = Buffer.alloc(512);
  data.write('MZ', 0, 'ascii');
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x00004550, 0x80);
  data.writeUInt16LE(0x8664, 0x84);
  return data;
}

async function expectZipError(zipBytes, root, expectedCode) {
  const archive = path.join(root, 'bad.zip');
  fs.writeFileSync(archive, zipBytes);
  await assert.rejects(extractZipArchive(archive, path.join(root, 'out-' + expectedCode)), error => error.code === expectedCode);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-qq-napcat-zip-'));
  try {
    const archivePath = path.join(tempRoot, 'node-fixture.zip');
    const contents = [
      { name: 'node.exe', data: makePeX64Stub() },
      { name: 'index.js', data: 'require("./napcat/napcat.mjs");' },
      { name: 'wrapper.node', data: 'native-binary-fixture' },
      { name: 'package.json', data: '{"name":"node-shell-fixture"}' },
      { name: 'config.json', data: '{}' },
      { name: 'napcat/napcat.mjs', data: 'export default true;' },
      { name: 'napcat/config/', data: '', directory: true },
      { name: 'zero.bin', data: Buffer.alloc(0) }
    ];
    const zipBytes = makeZip(contents);
    fs.writeFileSync(archivePath, zipBytes);
    const parsed = parseZip32(zipBytes);
    const inspected = inspectZipArchive(archivePath);
    assert.equal(parsed.entries.filter(entry => !entry.directory).length, 7);
    assert.equal(inspected.entryCount, 7);
    assert.equal(inspected.uncompressedBytes, contents.reduce((total, entry) => total + (entry.directory ? 0 : Buffer.byteLength(entry.data || '')), 0));
    const out = path.join(tempRoot, 'extracted');
    const report = await extractZipArchive(archivePath, out, { validatePackage: validateNodeBundle });
    assert.equal(report.ok, true);
    assert.equal(report.entryCount, 7);
    assert.equal(validateNodeBundle(out), true);
    assert.equal(fs.readFileSync(path.join(out, 'index.js'), 'utf8'), 'require("./napcat/napcat.mjs");');
    assert.equal(fs.readFileSync(path.join(out, 'zero.bin')).length, 0);
    const expectedNodeHash = crypto.createHash('sha256').update(makePeX64Stub()).digest('hex');
    assert.equal(report.files.find(file => file.name === 'node.exe').sha256, expectedNodeHash);

    const dotPrefixed = makeZip([
      { name: './', data: '', directory: true },
      { name: './node.exe', data: makePeX64Stub() },
      { name: './index.js', data: 'module.exports=true;' },
      { name: './wrapper.node', data: 'wrapper' },
      { name: './package.json', data: '{}' },
      { name: './config.json', data: '{}' },
      { name: './napcat/napcat.mjs', data: 'export default true;' }
    ]);
    assert.equal(parseZip32(dotPrefixed).entries.some(entry => entry.name === 'node.exe'), true, 'InfoZIP ./ prefixes are normalized safely');

    await expectZipError(makeZip([{ name: '../outside.txt', data: 'no' }]), tempRoot, 'zip-path-rejected');
    await expectZipError(makeZip([
      { name: 'node.exe', data: 'one' },
      { name: 'NODE.EXE', data: 'two' }
    ]), tempRoot, 'zip-duplicate-path');
    await expectZipError(makeZip([{ name: 'link', data: 'target', externalAttributes: ((0o120777 << 16) >>> 0) }]), tempRoot, 'zip-link-or-special-file');

    const corrupt = Buffer.from(zipBytes);
    const parsedEntry = parsed.entries.find(entry => !entry.directory && entry.name === 'index.js');
    corrupt[parsedEntry.dataOffset] ^= 0xff;
    const corruptPath = path.join(tempRoot, 'corrupt.zip');
    fs.writeFileSync(corruptPath, corrupt);
    await assert.rejects(extractZipArchive(corruptPath, path.join(tempRoot, 'corrupt-out')));

    console.log('QQ NapCat isolated ZIP extraction checks passed');
  } finally {
    const tempPath = path.resolve(tempRoot);
    assert.equal(path.basename(tempPath).startsWith('ib-qq-napcat-zip-'), true);
    assert.equal(tempPath.startsWith(path.resolve(os.tmpdir()) + path.sep), true);
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
