'use strict';

/* A small metadata-only Fathom projection stored beside canonical Memory in the
   existing Home Node SQLite file. It is not a second Memory store and never
   persists user text or writes MemoryRecord fields. */
const fs = require('fs');
const crypto = require('crypto');
const MEMORY_VIS = require('../../assets/js/memory-visibility-core.js');

const TABLE = 'memory_fathom_recall_events';
const KEEP_EVENTS = 2000;
const VISIBLE_LIMIT = 100000;

function createMemoryFathomHistory(deps) {
  deps = deps || {};
  const memoryStore = deps.memoryStore || null;
  const dbFile = String(deps.dbFile || (memoryStore && memoryStore.file) || '');
  const visibilityCore = deps.visibilityCore || MEMORY_VIS;
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  const logger = typeof deps.logger === 'function' ? deps.logger : function () {};
  let DatabaseSync = null;
  let schemaReady = false;
  try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (_) {}

  const CREATE = 'CREATE TABLE IF NOT EXISTS ' + TABLE + ' (' +
    'event_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL,' +
    'selected_ids_json TEXT NOT NULL, edges_json TEXT NOT NULL, counts_json TEXT NOT NULL)';

  function withDb(fn, write) {
    if (!DatabaseSync || !dbFile || !fs.existsSync(dbFile)
        || (memoryStore && typeof memoryStore.isOpen === 'function' && !memoryStore.isOpen())) {
      return { ok: false, error: 'fathom-storage-unavailable' };
    }
    let db = null;
    try {
      db = new DatabaseSync(dbFile);
      db.exec('PRAGMA busy_timeout = 5000');
      if (!schemaReady) { db.exec(CREATE); schemaReady = true; }
      if (!write) db.exec('PRAGMA query_only = ON');
      return fn(db);
    } catch (error) {
      return { ok: false, error: 'fathom-storage-unavailable', reason: String((error && error.code) || 'storage-failed') };
    } finally {
      try { if (db) db.close(); } catch (_) {}
    }
  }

  function visibleRecords(viewer) {
    if (!memoryStore || typeof memoryStore.listVisible !== 'function') return { ok: false, error: 'memory-reader-unavailable' };
    if (!visibilityCore || typeof visibilityCore.normalizeViewer !== 'function') return { ok: false, error: 'visibility-unavailable' };
    const principal = visibilityCore.normalizeViewer(viewer);
    if (!principal) return { ok: false, error: 'no-principal' };
    const page = memoryStore.listVisible({ viewer: principal, limit: VISIBLE_LIMIT });
    if (!page || page.ok !== true || page.reason || page.truncated) {
      return { ok: false, error: page && (page.error || page.reason) || 'visibility-incomplete' };
    }
    const group = String(principal).indexOf('group_') === 0;
    const records = group ? page.records.filter((record) => String(record.visibility || '') === 'public') : page.records;
    return { ok: true, viewer: String(principal), group: group, records: records };
  }

  function recordRecall(input) {
    input = input && typeof input === 'object' ? input : {};
    const scope = visibleRecords(input.characterId);
    if (!scope.ok) return scope;
    const channel = String(input.channel || '');
    if (channel !== 'chat' && channel !== 'group') return { ok: false, error: 'invalid-channel' };
    if ((channel === 'group') !== scope.group) return { ok: false, error: 'channel-scope-mismatch' };
    const ids = Array.isArray(input.selectedIds) ? input.selectedIds.map(String) : [];
    if (ids.length > 32 || ids.some((id) => !id || id.length > 160) || new Set(ids).size !== ids.length) {
      return { ok: false, error: 'invalid-selection' };
    }
    const byId = new Map(scope.records.map((record) => [String(record.id), record]));
    if (ids.some((id) => !byId.has(id))) return { ok: false, error: 'selection-not-visible' };
    const source = input.association && Array.isArray(input.association.edges) ? input.association.edges : [];
    if (source.length > 12) return { ok: false, error: 'invalid-association' };
    const edges = [];
    for (const edge of source) {
      const anchorMemoryId = String(edge && edge.anchorMemoryId || '');
      const relatedMemoryId = String(edge && edge.relatedMemoryId || '');
      const relation = String(edge && edge.relation || '').trim().slice(0, 80);
      if (!anchorMemoryId || !relatedMemoryId || !relation || !ids.includes(anchorMemoryId) || !byId.has(relatedMemoryId)) {
        return { ok: false, error: 'association-not-visible' };
      }
      edges.push({ anchorMemoryId: anchorMemoryId, relatedMemoryId: relatedMemoryId, relation: relation });
    }
    const rawCounts = input.counts && typeof input.counts === 'object' ? input.counts : {};
    const counts = {};
    ['candidates', 'eligible', 'selected'].forEach((key) => {
      const n = Number(rawCounts[key]);
      counts[key] = Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 1000000) : null;
    });
    const id = crypto.randomUUID();
    const at = Math.max(0, Math.trunc(Number(clock()) || Date.now()));
    const result = withDb((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO ' + TABLE + ' (event_id, character_id, channel, at, selected_ids_json, edges_json, counts_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, scope.viewer, channel, at, JSON.stringify(ids), JSON.stringify(edges), JSON.stringify(counts));
        db.prepare('DELETE FROM ' + TABLE + ' WHERE event_id IN (SELECT event_id FROM ' + TABLE + ' ORDER BY at DESC, event_id DESC LIMIT -1 OFFSET ?)')
          .run(KEEP_EVENTS);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
      return { ok: true, eventId: id, at: at, selected: ids.length, edges: edges.length };
    }, true);
    if (!result.ok) {
      try { logger('memory-fathom-recall-write-failed', { reason: result.reason || 'storage-failed' }); } catch (_) {}
    }
    return result;
  }

  function metadata(record) {
    return {
      id: String(record.id), title: String(record.title || '').slice(0, 160),
      domain: String(record.domain || '').slice(0, 80),
      tags: (Array.isArray(record.tags) ? record.tags : []).map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 24),
      kind: String(record.kind || 'episodic').slice(0, 40),
      created: Number(record.created || record.createdAt || 0) || 0,
      updated: Number(record.updated || record.updatedAt || record.created || record.createdAt || 0) || 0,
      pinned: record.pinned === true,
      importance: Number.isFinite(Number(record.importance)) ? Number(record.importance) : null
    };
  }

  function tidySuggestions(records) {
    const duplicateBuckets = new Map(), recordsByTag = new Map(), tagCleanup = [];
    records.forEach((record) => {
      const content = String(record.content || record.summary || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      if (content.length >= 12) {
        const bucket = duplicateBuckets.get(content) || [];
        bucket.push(String(record.id));
        duplicateBuckets.set(content, bucket);
      }
      const rawTags = Array.isArray(record.tags) ? record.tags : (typeof record.tags === 'string' ? record.tags.split(/[,，]/) : []);
      const tags = new Map();
      rawTags.forEach((tag) => {
        const clean = String(tag || '').normalize('NFKC').trim();
        if (!clean) return;
        const key = clean.toLocaleLowerCase();
        if (!tags.has(key)) tags.set(key, []);
        tags.get(key).push(clean);
      });
      const repeated = [];
      tags.forEach((values) => { if (values.length > 1) repeated.push.apply(repeated, values.slice(1)); });
      if (repeated.length) tagCleanup.push({ memoryId: String(record.id), removeTags: repeated.slice(0, 12) });
      const domain = String(record.domain || '').trim();
      if (!domain) return;
      tags.forEach((values, key) => {
        const peers = recordsByTag.get(key) || [];
        peers.push({ id: String(record.id), domain: domain });
        recordsByTag.set(key, peers);
      });
    });
    const duplicates = [];
    duplicateBuckets.forEach((ids) => { if (ids.length > 1) duplicates.push({ memoryIds: ids.slice(0, 12) }); });
    const categories = [], uncategorized = [];
    records.forEach((record) => {
      if (String(record.domain || '').trim()) return;
      const tags = Array.isArray(record.tags) ? record.tags : [];
      const sources = new Map(), sharedTags = new Map();
      tags.forEach((tag) => {
        const key = String(tag || '').normalize('NFKC').trim().toLocaleLowerCase();
        (recordsByTag.get(key) || []).forEach((peer) => {
          if (peer.id === String(record.id)) return;
          if (!sources.has(peer.domain)) sources.set(peer.domain, new Set());
          sources.get(peer.domain).add(peer.id);
          if (!sharedTags.has(peer.domain)) sharedTags.set(peer.domain, new Set());
          sharedTags.get(peer.domain).add(String(tag).normalize('NFKC').trim());
        });
      });
      let bestDomain = '', bestSources = [], bestTags = [];
      sources.forEach((set, domain) => {
        const ids = Array.from(set);
        if (ids.length >= 2 && (ids.length > bestSources.length || (ids.length === bestSources.length && domain < bestDomain))) {
          bestDomain = domain; bestSources = ids; bestTags = Array.from(sharedTags.get(domain) || []);
        }
      });
      if (bestDomain) categories.push({ memoryId: String(record.id), domain: bestDomain,
        evidenceIds: bestSources.slice(0, 4), sharedTags: bestTags.slice(0, 8) });
      else uncategorized.push(String(record.id));
    });
    return { duplicates: duplicates.slice(0, 100), categories: categories.slice(0, 100),
      uncategorized: uncategorized.slice(0, 100), tagCleanup: tagCleanup.slice(0, 100) };
  }

  function snapshot(options) {
    options = options || {};
    const scope = visibleRecords(options.viewer);
    if (!scope.ok) return scope;
    const group = scope.group, principal = scope.viewer, records = scope.records;
    const recordById = new Map(records.map((record) => [String(record.id), record]));
    const recordMeta = records.map(metadata).sort((a, b) => (b.updated - a.updated) || a.id.localeCompare(b.id));
    const uiRecords = recordMeta.slice(0, 500);
    const result = withDb((db) => {
      const limit = Math.max(1, Math.min(100, Math.trunc(Number(options.limit) || 80)));
      const recallRows = db.prepare('SELECT event_id, channel, at, selected_ids_json, edges_json, counts_json FROM ' + TABLE + ' WHERE character_id=? ORDER BY at DESC, event_id DESC LIMIT ?').all(principal, limit);
      const recalls = recallRows.map((row) => {
        let selectedIds = [], edges = [], counts = {};
        try { selectedIds = JSON.parse(row.selected_ids_json || '[]'); } catch (_) {}
        try { edges = JSON.parse(row.edges_json || '[]'); } catch (_) {}
        try { counts = JSON.parse(row.counts_json || '{}'); } catch (_) {}
        selectedIds = Array.isArray(selectedIds) ? selectedIds.map(String).filter((id) => recordById.has(id)) : [];
        edges = Array.isArray(edges) ? edges.slice(0, 12).filter((edge) => edge
          && selectedIds.indexOf(String(edge.anchorMemoryId || '')) >= 0
          && recordById.has(String(edge.relatedMemoryId || ''))).map((edge) => ({
            anchorMemoryId: String(edge.anchorMemoryId), relatedMemoryId: String(edge.relatedMemoryId),
            relation: String(edge.relation || '').slice(0, 80)
          })) : [];
        return { id: String(row.event_id), kind: 'recall', channel: String(row.channel), at: Number(row.at) || 0,
          selectedIds: selectedIds.slice(0, 32), edges: edges, counts: counts && typeof counts === 'object' ? counts : {} };
      });
      const timeline = recalls.slice();
      const canReadDeleted = (record) => group
        ? String(record && record.visibility || '') === 'public'
        : !!(visibilityCore && typeof visibilityCore.canReadMemory === 'function' && visibilityCore.canReadMemory(record, principal).ok);
      try {
        const changes = db.prepare('SELECT revision, kind, record_id, at FROM memory_change_log ORDER BY revision DESC LIMIT 1000').all();
        const readRecord = db.prepare('SELECT deleted_at, payload_json FROM memory_records WHERE record_id=?');
        for (const change of changes) {
          const id = String(change.record_id || '');
          if (!id) continue;
          if (change.kind === 'upsert') {
            if (recordById.has(id)) timeline.push({ id: 'write:' + String(change.revision), kind: 'write', recordId: id,
              revision: Number(change.revision) || 0, at: Number(change.at) || 0 });
            continue;
          }
          const row = readRecord.get(id);
          if (!row || row.deleted_at == null) continue;
          let deleted = null; try { deleted = JSON.parse(row.payload_json || 'null'); } catch (_) {}
          if (!deleted || !canReadDeleted(deleted)) continue;
          timeline.push({ id: 'remove:' + String(change.revision), kind: 'remove', recordId: id,
            revision: Number(change.revision) || 0, at: Number(change.at) || 0 });
        }
      } catch (_) {}
      timeline.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
      const boundedTimeline = timeline.slice(0, 120);
      const idsInOutput = new Set(uiRecords.map((row) => row.id));
      boundedTimeline.forEach((event) => {
        const refs = [event.recordId].concat(event.selectedIds || []);
        (event.edges || []).forEach((edge) => refs.push(edge.anchorMemoryId, edge.relatedMemoryId));
        refs.forEach((id) => { if (id && recordById.has(String(id)) && !idsInOutput.has(String(id))) {
          uiRecords.push(metadata(recordById.get(String(id)))); idsInOutput.add(String(id));
        }});
      });
      return { ok: true, recalls: recalls, timeline: boundedTimeline, records: uiRecords.slice(0, 740),
        recordsTruncated: recordMeta.length > 500 };
    }, false);
    if (!result.ok) return result;
    return {
      ok: true, viewer: principal, revision: Number(memoryStore.meta && memoryStore.meta().revision) || 0,
      visibleRecordCount: records.length, records: result.records, recordsTruncated: result.recordsTruncated,
      recalls: result.recalls, timeline: result.timeline, tidy: tidySuggestions(records),
      capabilities: { recalls: true, writes: true, removals: true, expirations: false, benchmark: true, tidySuggestions: true }
    };
  }

  return { recordRecall: recordRecall, snapshot: snapshot, role: 'METADATA_ONLY_FATHOM_PROJECTION' };
}

module.exports = createMemoryFathomHistory;
module.exports.createMemoryFathomHistory = createMemoryFathomHistory;
