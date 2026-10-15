'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyRawFiles, verifyRawFiles } = require('../scripts/create-release-source-snapshot.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-release-snapshot-byte-test-'));
const source = path.join(root, 'source');
const copy = path.join(root, 'copy');
const fixtures = [
  { path: 'utf8-bom-lf.txt', bytes: Buffer.from([0xEF, 0xBB, 0xBF, 0x61, 0x0A, 0x62, 0x0A]) },
  { path: 'ansi-crlf.vbs', bytes: Buffer.from([0xB2, 0xE2, 0xCA, 0xD4, 0x0D, 0x0A, 0x52, 0x75, 0x6E]) },
  { path: 'binary.bin', bytes: Buffer.from([0x00, 0xFF, 0x0D, 0x0A, 0x80, 0x01]) }
];

try {
  for (const file of fixtures) {
    const full = path.join(source, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.bytes);
  }
  const entries = fixtures.map(file => ({ path: file.path, origin: 'synthetic', classification: 'test-fixture' }));
  const copied = copyRawFiles(source, copy, entries);
  assert.equal(copied.length, fixtures.length);
  for (const file of fixtures) {
    const sourceBytes = fs.readFileSync(path.join(source, ...file.path.split('/')));
    const copyBytes = fs.readFileSync(path.join(copy, ...file.path.split('/')));
    assert.deepEqual(copyBytes, sourceBytes, file.path + ' must be copied byte-for-byte');
  }
  assert.deepEqual(verifyRawFiles(source, copy, copied), []);
  console.log('PASS source snapshot copy preserves BOM, LF, CRLF, ANSI and binary bytes');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
