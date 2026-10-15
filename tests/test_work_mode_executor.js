'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const executor = require('../assets/js/work-mode-executor.js');
const routeCore = require('../assets/js/work-mode-provider-route.js');
const consentCore = require('../assets/js/work-mode-consent-core.js');
const createWorkRunStore = require('../services/home-node/work-run-store.js');

const endpoint = 'https://provider.synthetic.invalid/v1/chat/completions';
const role = {
  id: 'character_alpha', nickname: 'Synthetic Role Alpha', apiProfileRef: 'profile_alpha', isRole: true,
  systemPrompt: 'IB_SYNTHETIC_PERSONA_ALPHA. Speak with measured confidence.',
  avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+p8AAAAASUVORK5CYII=',
  provider: 'openai', model: 'synthetic-model', endpoint, credentialRef: 'vault_herta'
};
const profile = {
  id: 'profile_alpha', nickname: 'Synthetic Alpha Model', provider: 'openai', roleSelectable: false,
  model: 'synthetic-model', endpoint, credentialRef: 'vault_herta'
};

async function snapshotFor(choice) {
  return executor.createSnapshot({
    choice: choice,
    role: choice.roleId ? role : null,
    profile: profile,
    routeCore: routeCore,
    consentCore: consentCore,
    crypto: crypto.webcrypto
  });
}

async function main() {
  assert.deepEqual(Object.keys(executor.PRESETS).sort(), ['app-builder', 'coding', 'general', 'research']);
  for (const presetId of ['general', 'research']) {
    const preset = executor.preset(presetId);
    assert.deepEqual(preset.allowedTools, [executor.TOOL_PROJECT_READ], 'read-only presets expose only consented file reads');
  }
  assert.deepEqual(executor.preset('coding').allowedTools,
    [executor.TOOL_PROJECT_READ, executor.TOOL_PROJECT_CREATE, executor.TOOL_PROJECT_UPDATE],
    'Coding exposes only consented Workspace read/create/update tools');
  assert.deepEqual(executor.preset('app-builder').allowedTools, executor.APP_DRAFT_TOOLS,
    'App Builder receives only the bounded Home Node App Draft tools');
  assert.deepEqual(Object.fromEntries(Object.entries(executor.PRESETS).map(([id, value]) => [id, value.maxProjectReadCalls])),
    { general: 1, coding: 12, research: 8, 'app-builder': 0 }, 'App Builder cannot read selected Workspace files');
  assert.notEqual(executor.preset('coding').strategy, executor.preset('research').strategy);
  assert.notEqual(executor.preset('research').strategy, executor.preset('app-builder').strategy);

  const choice = { roleId: role.id, profileRef: profile.id, presetId: 'coding' };
  const snapshot = await snapshotFor(choice);
  assert(snapshot, 'an existing role plus its model profile makes a normalized executor snapshot');
  assert.equal(snapshot.roleId, role.id);
  assert.equal(snapshot.roleName, role.nickname);
  assert.equal(snapshot.profileRef, profile.id);
  assert.equal(snapshot.maxProjectReadCalls, 12);
  assert.equal(snapshot.providerScope.providerRef, profile.id);
  assert.equal(snapshot.providerScope.model, profile.model);
  assert.equal(snapshot.allowedTools.includes('shell'), false);
  assert.equal(executor.normalizeSnapshot(Object.assign({}, snapshot, { allowedTools: ['shell'] })), null,
    'a client cannot expand the preset tool policy');
  const prompt = executor.composePrompt(snapshot, role.systemPrompt, 'Inspect the authorized workspace.');
  assert(prompt.includes(role.systemPrompt));
  assert(prompt.includes('【Agent 预设 · Coding】'));
  assert(prompt.includes('project.create_file') && prompt.includes('project.update_file'));
  assert(prompt.includes('最终权限边界'));
  assert.equal(prompt.includes('Chat Memory'), true, 'the execution guard names Chat Memory as out of scope');
  assert.equal(JSON.stringify(snapshot).includes('vault_herta'), false, 'run snapshots do not persist credential references');
  assert.equal(JSON.stringify(snapshot).includes('systemPrompt'), false, 'persona text is hash-bound, not copied into the run ledger');

  const overrideProfile = Object.assign({}, profile, { id: 'profile_manual_override', nickname: 'Manual Override Model', model: 'synthetic-override-model' });
  const overridden = await executor.createSnapshot({
    choice: { roleId: role.id, profileRef: overrideProfile.id, presetId: 'coding' },
    role: role, profile: overrideProfile, routeCore: routeCore, consentCore: consentCore, crypto: crypto.webcrypto
  });
  assert(overridden, 'a character identity can use an independently selected Provider Profile');
  assert.equal(overridden.roleId, role.id);
  assert.equal(overridden.roleName, role.nickname);
  assert.equal(overridden.profileRef, overrideProfile.id);
  assert.equal(overridden.providerScope.model, overrideProfile.model);
  assert.equal(overridden.personaHash, snapshot.personaHash, 'manual model override preserves the selected character persona');

  const changedRole = Object.assign({}, role, { systemPrompt: role.systemPrompt + ' Changed.' });
  const changedSnapshot = await executor.createSnapshot({
    choice: choice, role: changedRole, profile: profile, routeCore: routeCore,
    consentCore: consentCore, crypto: crypto.webcrypto
  });
  assert.notEqual(changedSnapshot.personaHash, snapshot.personaHash,
    'editing a character after Run creation produces a different pinned identity');
  const roleless = await snapshotFor({ roleId: '', profileRef: profile.id, presetId: 'general' });
  assert(roleless);
  assert.equal(roleless.roleName, '标准 Agent');
  assert.equal(roleless.personaHash, await executor.digestText('', crypto.webcrypto));

  const customRole = Object.assign({}, profile, { id: 'character_custom', nickname: 'Custom Role without Prompt', isRole: true,
    roleSelectable: true, apiProfileRef: 'profile_alpha', systemPrompt: '' });
  const providerOnly = Object.assign({}, profile, { id: 'profile_plain', roleSelectable: false });
  const middleBrainProfile = Object.assign({}, profile, { id: 'middle_review_profile', nickname: 'Middle Brain Review Model' });
  const middleBrainRole = Object.assign({}, role, { id: 'middle_brain_character', nickname: 'Review Agent',
    apiProfileRef: middleBrainProfile.id });
  const roles = executor.roleCatalog([role, profile, customRole, providerOnly, middleBrainProfile, middleBrainRole], routeCore);
  assert.deepEqual(roles.map(item => item.roleId), [role.id, customRole.id],
    'role discovery includes ordinary custom roles while excluding Middle Brain provider profiles');
  assert.equal(roles[0].avatar, role.avatar, 'safe inline raster avatar is available to the DSH selector');
  assert.equal(roles[0].profileRef, profile.id, 'role catalog resolves the configured default Provider Profile');
  assert.equal(JSON.stringify(roles).includes('systemPrompt'), false);
  assert.equal(JSON.stringify(roles).includes('credentialRef'), false);
  assert.deepEqual(executor.profileCatalog([role, profile, middleBrainProfile], routeCore).map(item => item.profileRef), [role.id, profile.id]);
  assert.equal(executor.isMiddleBrainProfile(middleBrainProfile), true);
  assert.equal(executor.isMiddleBrainProfile(Object.assign({}, profile, { middleBrainOnly: true })), true,
    'explicit Middle Brain metadata also excludes a provider profile from both selectors');

  const sameRouteDifferentCredential = Object.assign({}, profile, { credentialRef: 'vault_other' });
  const routeA = routeCore.normalize(profile), routeB = routeCore.normalize(sameRouteDifferentCredential);
  const scopeA = await consentCore.providerScope('agent', profile.id, routeA, crypto.webcrypto);
  const scopeB = await consentCore.providerScope('agent', profile.id, routeB, crypto.webcrypto);
  assert.notEqual(scopeA.routeHash, scopeB.routeHash, 'Consent and Run binding distinguish credential refs under the same endpoint/model');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-work-mode-executor-'));
  let store = createWorkRunStore({ dataDir, logger: () => {} });
  try {
    store.open();
    const created = store.createRun({ requestId: 'executor-run-create', workflowId: createWorkRunStore.CODING_WORKFLOW_ID,
      projectRef: 'synthetic_project', executorSelection: snapshot });
    assert.equal(created.ok, true);
    assert.deepEqual(created.run.executorSelection, snapshot);
    store.close();
    store = createWorkRunStore({ dataDir, logger: () => {} });
    store.open();
    assert.deepEqual(store.getRun(created.run.runId).run.executorSelection, snapshot, 'run snapshot survives Home Node restart');
    const changedPreset = await snapshotFor({ roleId: role.id, profileRef: profile.id, presetId: 'research' });
    assert.equal(store.pinExecutorSelection({ runId: created.run.runId, expectedVersion: created.run.version,
      executorSelection: changedPreset }).code, 'EXECUTOR_SELECTION_LOCKED', 'a pinned Run cannot be retargeted');
    const generalSnapshot = await snapshotFor({ roleId: role.id, profileRef: profile.id, presetId: 'general' });
    const legacy = store.createRun({ requestId: 'executor-run-legacy', workflowId: createWorkRunStore.WORKFLOW_ID,
      projectRef: 'synthetic_project' });
    const pinned = store.pinExecutorSelection({ runId: legacy.run.runId, expectedVersion: legacy.run.version,
      executorSelection: generalSnapshot });
    assert.equal(pinned.ok, true, 'an unconfigured queued Run can be pinned once before Consent');
    assert.equal(store.pinExecutorSelection({ runId: legacy.run.runId, expectedVersion: legacy.run.version,
      executorSelection: changedPreset }).code, 'EXECUTOR_SELECTION_LOCKED');
    const codingRun = store.createRun({ requestId: 'executor-run-coding', workflowId: createWorkRunStore.CODING_WORKFLOW_ID,
      projectRef: 'synthetic_project', executorSelection: snapshot });
    assert.equal(codingRun.ok, true, 'Coding has its own explicitly typed Home Node workflow');
    const invalid = Object.assign({}, snapshot, { allowedTools: ['project.write_file'] });
    assert.equal(store.createRun({ requestId: 'executor-run-invalid', workflowId: createWorkRunStore.WORKFLOW_ID,
      projectRef: 'synthetic_project', executorSelection: invalid }).code, 'INVALID_EXECUTOR_SELECTION');
  } finally {
    try { store.close(); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('Work Mode executor role/preset snapshots passed (safe catalog, immutable route/persona, tool policy, restart).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
