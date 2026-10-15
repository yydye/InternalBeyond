'use strict';

/* Test-side view of the one authoritative Web Core schema module. */
const schema = require('../../assets/js/webcore-db-schema.js');

const storeNames = Object.freeze(schema.STORE_NAMES.slice());
const storeList = storeNames.map(name => "'" + name + "'").join(',');

function isWiredBeforeCore(html, coreSource) {
  const document = String(html || '');
  const core = String(coreSource || '');
  const schemaTag = /<script[^>]+src=["']assets\/js\/webcore-db-schema\.js["'][^>]*><\/script>/i.exec(document);
  const coreTag = /<script[^>]+src=["']assets\/js\/core\.js["'][^>]*><\/script>/i.exec(document);
  return !!schemaTag && !!coreTag && schemaTag.index < coreTag.index
    && /DB_SCHEMA\s*=\s*window\.IBWebCoreDbSchema/.test(core);
}

module.exports = Object.freeze({
  DB_NAME: schema.DB_NAME,
  DB_VERSION: schema.DB_VERSION,
  schema: schema,
  STORE_NAMES: storeNames,
  storeList: storeList,
  isWiredBeforeCore: isWiredBeforeCore,
  hasStore: name => storeNames.includes(String(name)),
  hasNone: names => (names || []).every(name => !storeNames.includes(String(name))),
  isVersion: (name, version) => schema.DB_NAME === name && schema.DB_VERSION === version
});
