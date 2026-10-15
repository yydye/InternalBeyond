'use strict';

/* P28-WM-P2 · the Work Mode cognition port is separate from the frozen Chat facade. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const consentCore = require('../assets/js/work-mode-consent-core.js');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'assets/js/middle-brain.js'), 'utf8');
const responses = [];
const calls = [];
const consentChecks = [];
let consentAllowed = true;
const context = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  crypto: crypto.webcrypto,
  TextEncoder: TextEncoder,
  IB: {
    __middleBrainContracts: {
      config: {
        MB_SYSTEM_PROMPT: 'existing Middle Brain policy',
        getMiddleBrainConfig: async function () { return { enabled: true, providerConfigId: 'profile_middle_brain' }; },
        loadMiddleBrainConfigUI: function () {}
      },
      policy: {},
      astra: { middleBrainModelCall: async function (prompt, options) {
        if (options && typeof options.beforeSend === 'function') {
          const gate = await options.beforeSend({
            consumer: options.consumer,
            provider: 'openai',
            model: 'mock-middle-brain',
            endpoint: 'https://provider.invalid/v1/responses'
          });
          if (!gate || gate.ok !== true) return { ok: false, error: 'consent-denied' };
        }
        calls.push({ prompt: prompt, options: options });
        return responses.shift();
      } },
      judge: {},
      integrity: {}
    },
    homeNode: { workRuns: { checkConsent: async function (runId, consentId, input) {
      consentChecks.push({ runId: runId, consentId: consentId, input: input });
      return consentAllowed ? { ok: true } : { ok: false, error: 'consent-revoked' };
    } } }
  }
};
context.IBWorkModeConsentCore = consentCore;
context.window = context;
context.self = context;
vm.runInNewContext(SOURCE, context, { filename: 'assets/js/middle-brain.js' });

async function main() {
  assert.strictEqual(Object.keys(context.IB.middleBrain).length, 56, 'Chat/Role Middle Brain facade stays frozen at 56 keys');
  assert.strictEqual(context.IB.middleBrain.middleBrainWorkModePlan, undefined);
  assert(Object.isFrozen(context.IB.workModeCognition), 'Work Mode gets an immutable task-scoped cognition port');

  const signal = { aborted: false };
  responses.push({ ok: true, content: '{"steps":[{"fileId":"pf_tests","focus":"tests"}]}' });
  const plan = await context.IB.workModeCognition.plan({
    projectRef: 'proj_alpha',
    files: [{ fileId: 'pf_tests', path: 'tests/a.js', size: 40 }]
  }, { signal: signal, authorization: { runId: 'wr_12345678-1234-1234-1234-123456789012', consentId: 'wrc_12345678-1234-1234-1234-123456789012' } });
  assert.strictEqual(plan.ok, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(plan.plan.steps)), [{ fileId: 'pf_tests', focus: 'tests' }]);
  assert.strictEqual(calls[0].options.consumer, 'middle_brain.work_mode.plan');
  assert.strictEqual(calls[0].options.signal, signal);
  assert(!calls[0].prompt.messages[0].content.includes('proj_alpha'), 'internal Workspace project IDs stay local');

  responses.push({ ok: true, content: '{"steps":[{"fileId":"pf_other","focus":"tests"}]}' });
  const invalidPlan = await context.IB.workModeCognition.plan({
    projectRef: 'proj_alpha', files: [{ fileId: 'pf_tests', path: 'tests/a.js', size: 40 }]
  }, { authorization: { runId: 'wr_12345678-1234-1234-1234-123456789012', consentId: 'wrc_12345678-1234-1234-1234-123456789012' } });
  assert.strictEqual(invalidPlan.error, 'invalid-plan-response', 'plan cannot invent Workspace file IDs');

  responses.push({ ok: true, content: '{"decision":"approve","issueCodes":[]}' });
  const review = await context.IB.workModeCognition.review({
    projectRef: 'proj_alpha',
    steps: [{ fileId: 'pf_tests', focus: 'tests' }],
    evidence: [{ fileId: 'pf_tests', path: 'tests/a.js', bytesRead: 40, excerpt: '4: assert.equal(x, true);' }],
    report: '{"summary":"Tests cover the branch","findings":[]}',
    dataClassification: 'project_only'
  }, { authorization: { runId: 'wr_12345678-1234-1234-1234-123456789012', consentId: 'wrc_12345678-1234-1234-1234-123456789012' } });
  assert.strictEqual(review.ok, true);
  assert.strictEqual(review.review.decision, 'approve');
  assert.strictEqual(calls[2].options.consumer, 'middle_brain.work_mode.review');
  assert(calls[2].prompt.system.includes('Do not execute tools'));
  assert(calls[2].prompt.messages[0].content.includes('assert.equal(x, true)'));
  assert(calls[2].prompt.messages[0].content.includes('"dataClassification":"project_only"'));
  assert(!calls[2].prompt.messages[0].content.includes('proj_alpha'));
  assert.strictEqual(consentChecks.length, 3, 'each plan/review outbound call verifies Home Node consent at the transport boundary');
  assert(consentChecks.every(check => check.input.projectRef === 'proj_alpha'
    && check.input.providerScope.destination === 'middle_brain'
    && check.input.fileIds.includes('pf_tests')));
  assert.deepStrictEqual(consentChecks.map(check => check.input.consumer), [
    'middle_brain_plan', 'middle_brain_plan', 'middle_brain_review'
  ], 'Home Node sees the fixed Work Mode consumer before each transmission');

  const before = calls.length;
  const rejectedEvidence = await context.IB.workModeCognition.review({
    projectRef: 'proj_alpha',
    steps: [{ fileId: 'pf_tests', focus: 'tests' }],
    evidence: [{ fileId: 'pf_other', path: '../outside.js', bytesRead: 10, excerpt: 'x' }],
    report: '{"summary":"x","findings":[]}', dataClassification: 'project_only'
  });
  assert.strictEqual(rejectedEvidence.error, 'invalid-review-input');
  assert.strictEqual(calls.length, before, 'invalid evidence must not reach the provider seam');

  const withoutConsent = await context.IB.workModeCognition.plan({
    projectRef: 'proj_alpha', files: [{ fileId: 'pf_tests', path: 'tests/a.js', size: 40 }]
  });
  assert.strictEqual(withoutConsent.error, 'consent-denied');
  assert.strictEqual(calls.length, before, 'Middle Brain cannot be called directly without an authorization envelope');

  consentAllowed = false;
  const deniedAtTransport = await context.IB.workModeCognition.plan({
    projectRef: 'proj_alpha', files: [{ fileId: 'pf_tests', path: 'tests/a.js', size: 40 }]
  }, { authorization: { runId: 'wr_12345678-1234-1234-1234-123456789012', consentId: 'wrc_12345678-1234-1234-1234-123456789012' } });
  assert.strictEqual(deniedAtTransport.error, 'consent-denied');
  assert.strictEqual(calls.length, before, 'a revoked Home Node grant blocks the Astra transport');

  const workModeSource = SOURCE.slice(SOURCE.indexOf('var MB_WORK_MODE_MAX_FILES'), SOURCE.indexOf('var MB_PUBLIC_API'));
  assert(!/dbGet|dbPut|executeTool|shell\.exec/.test(workModeSource), 'Middle Brain owns no Workspace read or tool execution authority');
  console.log('Work Mode Middle Brain port passed (plan/review validation, cancellation propagation, frozen Chat facade).');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
