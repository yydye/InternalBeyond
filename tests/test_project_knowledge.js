'use strict';

/* P32 · Browser/Tauri host and Project Knowledge contract smoke tests. */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createHost } = require('../assets/js/host-capability.js');
const { createProjectKnowledge } = require('../services/project-knowledge.js');
const { createWebServer } = require('../services/internal-beyond-server.js');
const direct = require('../assets/js/middle-brain-direct.js');

function writeFile(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function request(port, pathname, headers) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, { headers: headers || {} });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internalbeyond-p32-'));
  let server = null;
  try {
    writeFile(root, 'README.md', '# Fixture README\nBrowser host contract.\n');
    writeFile(root, 'docs/contracts/HOST_CONTRACT.md', '# Host Contract\n\n## Read Only\nProject Knowledge is read-only and carries provenance.\n');
    writeFile(root, 'docs/current/PROJECT_KNOWLEDGE.md', '# Project Knowledge\n\n## Search\nBounded indexed retrieval.\n');
    writeFile(root, 'docs/history/economy/OLD_ECONOMY.md', '# Historical Host\nLegacy transport notes.\n');
    writeFile(root, 'docs/credentials/secret.md', '# Should never be indexed\n');
    writeFile(root, '.env', 'TOKEN=must-not-be-indexed\n');
    writeFile(root, 'uploads/private.md', '# Should never be indexed\n');

    const knowledge = createProjectKnowledge({ root });
    const status = knowledge.status();
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.indexedDocs, 4);
    assert.ok(status.canonicalDocs >= 1);
    assert.ok(status.historicalDocs >= 1);

    const listed = knowledge.listProjectDocs();
    assert.ok(listed.docs.every((doc) => !/credentials|uploads|\.env/i.test(doc.relativePath)));
    const search = knowledge.searchProjectDocs('read-only provenance', { limit: 8 });
    assert.strictEqual(search.ok, true);
    assert.ok(search.results.some((result) => result.relativePath === 'docs/contracts/HOST_CONTRACT.md'));
    const hit = search.results.find((result) => result.relativePath === 'docs/contracts/HOST_CONTRACT.md');
    assert.ok(hit && hit.docId && hit.hash && hit.authority === 'CANONICAL');

    const read = knowledge.readProjectDoc(hit.docId, 'Read Only');
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.authority, 'CANONICAL');
    assert.match(read.content, /provenance/);
    assert.strictEqual(knowledge.readProjectDoc('../README.md').ok, false);

    const browserCalls = [];
    const browserHost = createHost({
      location: { protocol: 'http:' },
      fetch: async (url) => {
        browserCalls.push(url);
        return { ok: true, text: async () => JSON.stringify({ ok: true, results: [] }) };
      }
    });
    assert.strictEqual(browserHost.platform(), 'browser');
    assert.strictEqual(browserHost.capabilities().projectKnowledge.transport, 'browser-static');
    await browserHost.projectKnowledge.searchProjectDocs('contract', { limit: 2 });
    assert.strictEqual(browserCalls[0], '/__project-knowledge/search?q=contract&limit=2');

    const tauriCalls = [];
    const tauriHost = createHost({
      __TAURI__: {
        core: {
          invoke: async (name, args) => {
            tauriCalls.push({ name, args });
            return { ok: true, indexedDocs: 4, results: [] };
          }
        }
      }
    });
    assert.strictEqual(tauriHost.platform(), 'tauri');
    assert.strictEqual(tauriHost.capabilities().projectKnowledge.transport, 'tauri-command');
    await tauriHost.projectKnowledge.status();
    assert.deepStrictEqual(tauriCalls[0], { name: 'project_knowledge_status', args: undefined });

    const tauriRuntimeOnly = createHost({ __TAURI__: {}, location: { protocol: 'http:' }, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true }) }) });
    assert.strictEqual(tauriRuntimeOnly.platform(), 'tauri');
    assert.strictEqual(tauriRuntimeOnly.capabilities().projectKnowledge.transport, 'browser-static');

    const tauriOriginOnly = createHost({ location: { protocol: 'http:', origin: 'http://tauri.localhost' }, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true }) }) });
    assert.strictEqual(tauriOriginOnly.platform(), 'tauri');

    const tauriMarkerOnly = createHost({ location: { protocol: 'http:', origin: 'http://127.0.0.1:23120', search: '?ib_tauri_host=1' }, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true }) }) });
    assert.strictEqual(tauriMarkerOnly.platform(), 'tauri');

    const tauriWebViewOnly = createHost({ chrome: { webview: {} }, location: { protocol: 'http:' }, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true }) }) });
    assert.strictEqual(tauriWebViewOnly.platform(), 'tauri');

    const port = await freePort();
    server = createWebServer({ root, port, projectKnowledge: knowledge, identity: 'P32 test web' });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const endpoint = await request(port, '/__project-knowledge/search?q=read-only');
    assert.strictEqual(endpoint.status, 200);
    assert.strictEqual(endpoint.body.ok, true);
    const denied = await request(port, '/__project-knowledge/status', { Origin: 'https://evil.example' });
    assert.strictEqual(denied.status, 403);
    const method = await fetch('http://127.0.0.1:' + port + '/__project-knowledge/status', { method: 'POST' });
    assert.strictEqual(method.status, 405);

    const context = await direct.resolveContext({ query: 'read-only' }, {
      projectKnowledge: { searchProjectDocs: async () => ({ ok: true, indexedDocs: 1, results: [hit] }) },
      getCharacters: async () => [],
      getGroups: async () => [],
      getRelationships: async () => [],
      getChatByFriend: async () => [],
      getByIndex: async () => [],
      scan: async () => ({ count: 0 }),
      getMoments: async () => [],
      now: () => Date.now()
    });
    assert.ok(context.sources.some((source) => source.sourceType === 'project_doc'));
    assert.ok(context.text.includes('authority=CANONICAL'));
    assert.ok(context.stats.projectDocSources >= 1);

    const mixedContext = await direct.resolveContext({ query: 'read-only' }, {
      projectKnowledge: { searchProjectDocs: async () => ({ ok: true, indexedDocs: 1, results: [hit] }) },
      getCharacters: async () => [{ id: 'world-1', name: 'World', relationship: 'read-only world context' }],
      getGroups: async () => [],
      getRelationships: async () => [],
      getChatByFriend: async () => [],
      getByIndex: async () => [],
      scan: async () => ({ count: 0 }),
      getMoments: async () => [],
      now: () => Date.now()
    });
    assert.ok(mixedContext.sources.some((source) => source.sourceType === 'relationship'));
    assert.ok(mixedContext.sources.some((source) => source.sourceType === 'project_doc'));
    assert.ok(mixedContext.stats.worldContextChars > 0);
    assert.ok(mixedContext.stats.projectDocChars <= direct.MAX_PROJECT_DOC_CHARS);
    assert.ok(mixedContext.stats.chars <= direct.MAX_CONTEXT_CHARS);

    console.log('P32 Project Knowledge + Host Contract: all checks passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
