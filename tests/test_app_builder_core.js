'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../assets/js/app-builder-core.js');

function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = Object.create(null);
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true), method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true), nameSize = view.getUint16(offset + 26, true);
    const extraSize = view.getUint16(offset + 28, true), name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameSize));
    assert.equal(flags & 0x0800, 0x0800, 'ZIP entry paths are UTF-8');
    assert.equal(method, 0, 'the small source package uses path-safe stored entries');
    assert.ok(name && !name.startsWith('/') && !name.split('/').includes('..'));
    const start = offset + 30 + nameSize + extraSize;
    files[name] = decoder.decode(bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, 'ZIP includes a central directory');
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'ZIP ends with EOCD');
  return files;
}

test('App Builder package IDs, diffs, CSP preview and capability boundary are stable', () => {
  const draft = {
    draftRef: 'ad_123e4567-e89b-42d3-a456-426614174000', projectRef: 'synthetic-project',
    name: 'Todo', version: 3, changes: { 'app.js': { before: 'const a=1;', after: 'const a=2;' } },
    files: {
      'index.html': '<!doctype html><html><head><title>Todo</title></head><body><main id="app"></main></body></html>',
      'styles.css': 'main{color:#123}',
      'app.js': 'window.AppStorage.get("todos");'
    }
  };
  assert.equal(core.appIdForDraft(draft.draftRef), 'dsh-123e4567e89b42d3a4564266');
  assert.equal(core.normalizeDraft(draft).draftRef, draft.draftRef);
  assert.match(core.diff('one\ntwo\nthree', 'one\nTWO\nthree'), /- two[\s\S]*\+ TWO/);
  const srcdoc = core.buildSrcdoc(draft);
  assert.match(srcdoc, /Content-Security-Policy/);
  assert.match(srcdoc, /connect-src \'none\'/);
  assert.match(srcdoc, /sandbox|AppStorage|ib-generated-app-storage-request/);
  const standalone = core.buildStandaloneHtml(draft);
  assert.match(standalone, /standalone-app-storage-request/);
  assert.match(standalone, /localStorage\.setItem/);
  assert.match(standalone, /sandbox.*allow-scripts/);
  assert.doesNotMatch(standalone, /ib-generated-app-storage-request|Home Node|__TAURI__|fetch\(/);
  const sourceZip = unzipStored(core.buildSourceZip(draft));
  assert.deepEqual(Object.keys(sourceZip).sort(), ['README.md', 'app.js', 'index.html', 'standalone.html', 'styles.css']);
  assert.equal(sourceZip['index.html'], draft.files['index.html']);
  assert.equal(sourceZip['styles.css'], draft.files['styles.css']);
  assert.equal(sourceZip['app.js'], draft.files['app.js']);
  assert.match(sourceZip['README.md'], /已提交草稿版本：v3/);
  assert.match(sourceZip['standalone.html'], /standalone-app-storage-request/);
  assert.equal(core.normalizeDraft(Object.assign({}, draft, { files: Object.assign({}, draft.files, {
    'index.html': '<main><script>parent.document.body</script></main>'
  }) })), null);
  assert.equal(core.normalizeDraft(Object.assign({}, draft, { files: Object.assign({}, draft.files, {
    'app.js': 'fetch("https://example.com")'
  }) })), null);
});
