(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.IBActionRegistry = api;
    if (root.IB) root.IB.actionRegistry = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FILE_ID = '^[A-Za-z0-9_.:-]{1,180}$';
  var PROJECT_REF = '^[A-Za-z0-9_.:-]{1,180}$';
  var RUN_ID = '^wr_[A-Za-z0-9-]{36}$';
  var CONSENT_ID = '^wrc_[A-Za-z0-9-]{36}$';
  var RESULT_ID = '^wrres_[A-Za-z0-9_-]{1,180}$';
  var PROVIDER_REF = '^[A-Za-z0-9_.:-]{1,180}$';
  var ROUTE_HASH = '^[a-f0-9]{64}$';
  var FOCUS = ['entrypoint', 'configuration', 'implementation', 'tests', 'documentation', 'security', 'other'];
  var SEVERITY = ['critical', 'high', 'medium', 'low', 'info'];
  var REVIEW_ISSUES = ['unsupported_claim', 'missing_evidence', 'missed_scope', 'unsafe_recommendation', 'incomplete_review'];

  function schemaObject(required, properties, optional, extra) {
    return Object.assign({
      type: 'object',
      required: required,
      properties: properties,
      additionalProperties: false
    }, optional || {}, extra || {});
  }

  var providerScopeSchema = schemaObject(
    ['destination', 'providerRef', 'provider', 'model', 'routeHash'],
    {
      destination: { type: 'string', enum: ['agent', 'middle_brain'] },
      providerRef: { type: 'string', pattern: PROVIDER_REF, maxLength: 180 },
      provider: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,80}$', maxLength: 80 },
      model: { type: 'string', minLength: 1, maxLength: 120 },
      routeHash: { type: 'string', pattern: ROUTE_HASH, maxLength: 64 }
    }
  );

  var CONSENT_ID_SCHEMA = { type: 'string', pattern: CONSENT_ID, maxLength: 40 };
  var RUN_ID_SCHEMA = { type: 'string', pattern: RUN_ID, maxLength: 39 };

  var planStepSchema = schemaObject(
    ['fileId', 'focus'],
    {
      fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
      focus: { type: 'string', enum: FOCUS }
    }
  );

  var inspectionDirectorySchema = schemaObject(
    ['path', 'fileCount'],
    {
      path: { type: 'string', minLength: 1, maxLength: 400 },
      fileCount: { type: 'integer', minimum: 1, maximum: 200 }
    }
  );

  var inspectionExtensionSchema = schemaObject(
    ['extension', 'fileCount'],
    {
      extension: { type: 'string', maxLength: 20 },
      fileCount: { type: 'integer', minimum: 1, maximum: 200 }
    }
  );

  var inspectionFileSchema = schemaObject(
    ['fileId', 'path', 'size'],
    {
      fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
      path: { type: 'string', minLength: 1, maxLength: 400 },
      size: { type: 'integer', minimum: 0, maximum: 131072 }
    }
  );

  var resultDraftFindingSchema = schemaObject(
    ['fileId', 'line', 'severity', 'title', 'detail'],
    {
      fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
      line: { type: 'integer', minimum: 1, nullable: true },
      severity: { type: 'string', enum: SEVERITY },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      detail: { type: 'string', minLength: 1, maxLength: 500 }
    }
  );

  var artifactFindingSchema = schemaObject(
    ['fileId', 'path', 'line', 'severity', 'title', 'detail'],
    {
      fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
      path: { type: 'string', minLength: 1, maxLength: 400 },
      line: { type: 'integer', minimum: 1, nullable: true },
      severity: { type: 'string', enum: SEVERITY },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      detail: { type: 'string', minLength: 1, maxLength: 500 }
    }
  );

  var resultArtifactSchema = schemaObject(
    ['schemaVersion', 'summary', 'findings'],
    {
      schemaVersion: { type: 'integer', enum: [1] },
      summary: { type: 'string', minLength: 1, maxLength: 2000 },
      findings: { type: 'array', maxItems: 8, items: artifactFindingSchema }
    }
  );

  /* Work Run v1 stores one immutable Result row per Run. Its resultId is the
     Artifact revision reference; schemaVersion identifies only the payload format. */
  var resultReferenceSchema = schemaObject(
    ['runId', 'resultId'],
    {
      runId: RUN_ID_SCHEMA,
      resultId: { type: 'string', pattern: RESULT_ID, maxLength: 186 }
    }
  );

  var resultCompareMetadataSchema = schemaObject(
    ['field', 'sourceValue', 'targetValue'],
    {
      field: { type: 'string', enum: ['workflowId', 'artifactCreatedAt', 'runCreatedAt', 'schemaVersion', 'findingCount'] },
      sourceValue: { type: 'string', maxLength: 180 },
      targetValue: { type: 'string', maxLength: 180 }
    }
  );

  var generationOutputSchema = {
    oneOf: [
      schemaObject(
        ['kind', 'name', 'fileId'],
        {
          kind: { type: 'string', enum: ['tool_call'] },
          name: { type: 'string', enum: ['project.read_file'] },
          fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 }
        }
      ),
      schemaObject(
        ['kind', 'summary', 'findings'],
        {
          kind: { type: 'string', enum: ['final'] },
          summary: { type: 'string', minLength: 1, maxLength: 2000 },
          findings: { type: 'array', maxItems: 8, items: resultDraftFindingSchema }
        }
      ),
      resultArtifactSchema,
      schemaObject(
        ['schemaVersion', 'summary'],
        {
          schemaVersion: { type: 'integer', enum: [1] },
          summary: { type: 'string', minLength: 1, maxLength: 1200 }
        }
      )
    ]
  };

  var ACTIONS = [
    {
      actionId: 'ib.work.plan.v1',
      executionMode: 'runtime_internal',
      requiredAuthority: ['WorkRunStore', 'MiddleBrainPlanPort'],
      consentRequirement: {
        ledger: 'WorkRunConsent', consumer: 'middle_brain_plan',
        providerRoute: 'exact middle_brain route', resourceScope: 'Run project and selected files'
      },
      inputSchema: schemaObject(
        ['runId', 'consentId', 'projectRef', 'files'],
        {
          runId: RUN_ID_SCHEMA,
          consentId: CONSENT_ID_SCHEMA,
          projectRef: { type: 'string', pattern: PROJECT_REF, maxLength: 180 },
          files: {
            type: 'array', minItems: 0, maxItems: 200,
            items: schemaObject(
              ['fileId', 'path', 'size'],
              {
                fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
                path: { type: 'string', minLength: 1, maxLength: 400 },
                size: { type: 'integer', minimum: 0 }
              }
            )
          }
        }
      ),
      outputSchema: schemaObject(
        ['steps'],
        { steps: { type: 'array', maxItems: 12, items: planStepSchema } }
      )
    },
    {
      actionId: 'ib.project.inspect.v1',
      executionMode: 'runtime_internal',
      requiredAuthority: ['WorkRunStore.checkConsent', 'WorkspaceProjectTool.snapshot'],
      consentRequirement: {
        ledger: 'WorkRunConsent', consumer: 'agent',
        providerRoute: 'exact active Run route is validated locally and is not called by this Action',
        resourceScope: 'fileIds must be the current Run Consent scope'
      },
      inputSchema: schemaObject(
        ['runId', 'consentId', 'projectRef', 'fileIds'],
        {
          runId: RUN_ID_SCHEMA,
          consentId: CONSENT_ID_SCHEMA,
          projectRef: { type: 'string', pattern: PROJECT_REF, maxLength: 180 },
          fileIds: {
            type: 'array', maxItems: 200, uniqueItems: true,
            items: { type: 'string', pattern: FILE_ID, maxLength: 180 }
          }
        }
      ),
      outputSchema: schemaObject(
        ['projectRef', 'scope', 'fileCount', 'displayableFileCount', 'omittedFileCount', 'totalBytes', 'directories', 'extensions', 'files'],
        {
          projectRef: { type: 'string', pattern: PROJECT_REF, maxLength: 180 },
          projectName: { type: 'string', maxLength: 180 },
          scope: { type: 'string', enum: ['run-consented-files'] },
          fileCount: { type: 'integer', minimum: 0, maximum: 200 },
          displayableFileCount: { type: 'integer', minimum: 0, maximum: 200 },
          omittedFileCount: { type: 'integer', minimum: 0, maximum: 200 },
          totalBytes: { type: 'integer', minimum: 0, maximum: 26214400 },
          directories: { type: 'array', maxItems: 200, items: inspectionDirectorySchema },
          extensions: { type: 'array', maxItems: 200, items: inspectionExtensionSchema },
          files: { type: 'array', maxItems: 200, items: inspectionFileSchema }
        }
      )
    },
    {
      actionId: 'ib.result.compare.v1',
      executionMode: 'runtime_internal',
      requiredAuthority: ['HomeNodeWorkRunStore.getRun', 'HomeNodeWorkRunStore.getAuthorizedResultReference', 'WorkRunActionTrace'],
      consentRequirement: {
        ledger: 'Home Node Work Run Authority', consumer: 'read_only_result_compare',
        resourceScope: 'source and target immutable Result references must share the current Run projectRef'
      },
      inputSchema: schemaObject(
        ['runId', 'sourceResultRef', 'targetArtifactRevision'],
        {
          runId: RUN_ID_SCHEMA,
          sourceResultRef: resultReferenceSchema,
          targetArtifactRevision: resultReferenceSchema
        }
      ),
      outputSchema: schemaObject(
        ['schemaVersion', 'sourceResultRef', 'targetArtifactRevision', 'summary', 'statusChange', 'metadataDiff'],
        {
          schemaVersion: { type: 'integer', enum: [1] },
          sourceResultRef: resultReferenceSchema,
          targetArtifactRevision: resultReferenceSchema,
          summary: schemaObject(
            ['sourceFindingCount', 'targetFindingCount', 'addedFindings', 'removedFindings', 'changedFindings', 'summaryChanged'],
            {
              sourceFindingCount: { type: 'integer', minimum: 0, maximum: 8 },
              targetFindingCount: { type: 'integer', minimum: 0, maximum: 8 },
              addedFindings: { type: 'integer', minimum: 0, maximum: 8 },
              removedFindings: { type: 'integer', minimum: 0, maximum: 8 },
              changedFindings: { type: 'integer', minimum: 0, maximum: 8 },
              summaryChanged: { type: 'boolean' }
            }
          ),
          statusChange: schemaObject(
            ['sourceRunStatus', 'targetRunStatus', 'sourceResultStatus', 'targetResultStatus', 'changed'],
            {
              sourceRunStatus: { type: 'string', minLength: 1, maxLength: 40 },
              targetRunStatus: { type: 'string', minLength: 1, maxLength: 40 },
              sourceResultStatus: { type: 'string', enum: ['available'] },
              targetResultStatus: { type: 'string', enum: ['available'] },
              changed: { type: 'boolean' }
            }
          ),
          metadataDiff: { type: 'array', maxItems: 5, items: resultCompareMetadataSchema }
        }
      )
    },
    {
      actionId: 'ib.workspace.read_file.v1',
      legacyToolNames: ['project.read_file'],
      executionMode: 'agent_request_dispatched',
      requiredAuthority: ['WorkRunStore.checkConsent', 'WorkspaceProjectTool or DSHHost'],
      consentRequirement: {
        ledger: 'WorkRunConsent', consumer: 'agent', providerRoute: 'exact agent route',
        resourceScope: 'fileId must be in both Run Consent and current Plan'
      },
      inputSchema: schemaObject(
        ['fileId'],
        { fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 } }
      ),
      outputSchema: schemaObject(
        ['ok', 'fileId', 'path', 'content', 'bytesRead', 'redactedSecrets', 'lastModified'],
        {
          ok: { type: 'boolean', enum: [true] },
          fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
          path: { type: 'string', minLength: 1, maxLength: 400 },
          content: { type: 'string', maxLength: 131072 },
          bytesRead: { type: 'integer', minimum: 0, maximum: 131072 },
          redactedSecrets: { type: 'integer', minimum: 0 },
          lastModified: { type: 'integer', minimum: 0 }
        }
      )
    },
    {
      actionId: 'ib.work.result.generate.v1',
      executionMode: 'runtime_internal',
      requiredAuthority: ['AgentModelPort or DSHHost', 'WorkRunStore'],
      consentRequirement: {
        ledger: 'WorkRunConsent', consumer: 'agent', providerRoute: 'exact agent route',
        resourceScope: 'Run plan and Consent-selected files; selected Memory remains separately bound'
      },
      inputSchema: {
        oneOf: [
          schemaObject(
              ['mode', 'runId', 'consentId', 'projectRef', 'providerScope', 'messages', 'jsonMode', 'budget', 'executor'],
            {
              mode: { type: 'string', enum: ['native'] },
                runId: RUN_ID_SCHEMA,
                consentId: CONSENT_ID_SCHEMA,
              projectRef: { type: 'string', pattern: PROJECT_REF, maxLength: 180 },
              providerScope: providerScopeSchema,
              messages: {
                type: 'array', minItems: 2, maxItems: 2,
                items: schemaObject(
                  ['role', 'content'],
                  { role: { type: 'string', enum: ['system', 'user'] }, content: { type: 'string', minLength: 1, maxLength: 32000 } }
                )
              },
              jsonMode: { type: 'boolean', enum: [true] },
              budget: { type: 'integer', minimum: 1, maximum: 1800 },
              executor: schemaObject(
                ['disableTools', 'timeoutMs'],
                { disableTools: { type: 'boolean', enum: [true] }, timeoutMs: { type: 'integer', enum: [90000] } }
              )
            }
          ),
          schemaObject(
            ['mode', 'workflowId', 'runId', 'consentId', 'projectRef', 'providerRef', 'sessionId', 'plannedFileIds', 'deferResult', 'prompt', 'timeoutMs'],
            {
              mode: { type: 'string', enum: ['dsh'] },
              workflowId: { type: 'string', enum: ['project.audit.readonly', 'coding.workspace', 'app.builder'] },
              runId: RUN_ID_SCHEMA,
              consentId: CONSENT_ID_SCHEMA,
              projectRef: { type: 'string', pattern: PROJECT_REF, maxLength: 180 },
              providerRef: { type: 'string', pattern: PROVIDER_REF, maxLength: 180 },
              sessionId: { type: 'string', pattern: '^session-[0-9a-fA-F-]{36}$', maxLength: 44 },
              plannedFileIds: { type: 'array', maxItems: 200, items: { type: 'string', pattern: FILE_ID, maxLength: 180 } },
              deferResult: { type: 'boolean', enum: [true] },
              prompt: { type: 'string', minLength: 1, maxLength: 28000 },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 }
            }
          )
        ]
      },
      outputSchema: generationOutputSchema
    },
    {
      actionId: 'ib.work.review_result.v1',
      executionMode: 'runtime_internal',
      requiredAuthority: ['WorkRunStore.checkConsent', 'MiddleBrainReviewPort'],
      consentRequirement: {
        ledger: 'WorkRunConsent', consumer: 'middle_brain_review', providerRoute: 'exact middle_brain route',
        resourceScope: 'Evidence file IDs; memory-derived Review sink consent when applicable'
      },
      inputSchema: schemaObject(
        ['runId', 'consentId', 'projectRef', 'steps', 'evidence', 'report', 'dataClassification'],
        {
          runId: RUN_ID_SCHEMA,
          consentId: CONSENT_ID_SCHEMA,
          projectRef: { type: 'string', pattern: PROJECT_REF, maxLength: 180 },
          steps: { type: 'array', maxItems: 12, items: planStepSchema },
          evidence: {
            type: 'array', maxItems: 12,
            items: schemaObject(
              ['fileId', 'path', 'bytesRead', 'excerpt'],
              {
                fileId: { type: 'string', pattern: FILE_ID, maxLength: 180 },
                path: { type: 'string', minLength: 1, maxLength: 400 },
                bytesRead: { type: 'integer', minimum: 0, maximum: 131072 },
                excerpt: { type: 'string', maxLength: 3000 }
              }
            )
          },
          report: { type: 'string', minLength: 1, maxLength: 10000 },
          dataClassification: { type: 'string', enum: ['project_only', 'memory_derived'] }
        }
      ),
      outputSchema: schemaObject(
        ['decision', 'issueCodes'],
        {
          decision: { type: 'string', enum: ['approve', 'revise'] },
          issueCodes: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', enum: REVIEW_ISSUES } }
        }
      )
    },
    {
      actionId: 'ib.work.persist_result.v1',
      executionMode: 'runtime_internal',
      requiredAuthority: ['HomeNodeWorkRunStore.complete'],
      consentRequirement: {
        ledger: 'WorkRunConsent', consumer: 'complete',
        sink: 'plaintext Work Result storage; memory-derived Result sink consent when applicable'
      },
      inputSchema: schemaObject(
        ['runId', 'requestId', 'expectedVersion', 'consentId', 'result'],
        {
          runId: { type: 'string', pattern: RUN_ID, maxLength: 39 },
          requestId: { type: 'string', minLength: 1, maxLength: 180 },
          expectedVersion: { type: 'integer', minimum: 1 },
          consentId: { type: 'string', pattern: CONSENT_ID, maxLength: 40 },
          result: resultArtifactSchema
        }
      ),
      outputSchema: schemaObject(
        ['ok', 'run', 'result'],
        {
          ok: { type: 'boolean', enum: [true] },
          duplicate: { type: 'boolean' },
          run: schemaObject(
            ['runId', 'status', 'version'],
            { runId: { type: 'string', pattern: RUN_ID, maxLength: 39 }, status: { type: 'string', minLength: 1, maxLength: 40 }, version: { type: 'integer', minimum: 1 } },
            {}, { additionalProperties: true }
          ),
          result: schemaObject(
            ['resultId', 'runId', 'schemaVersion', 'status', 'report'],
            {
              resultId: { type: 'string', minLength: 1, maxLength: 80 },
              runId: { type: 'string', pattern: RUN_ID, maxLength: 39 },
              schemaVersion: { type: 'integer', enum: [1] },
              status: { type: 'string', enum: ['available'] },
              report: resultArtifactSchema
            },
            {}, { additionalProperties: true }
          )
        }
      )
    }
  ];

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }
  ACTIONS.forEach(deepFreeze);
  Object.freeze(ACTIONS);

  function invalid(path) { return { ok: false, error: 'ACTION_SCHEMA_INVALID', path: path || '$' }; }
  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function validateSchema(schema, value, path) {
    path = path || '$';
    if (!schema || typeof schema !== 'object') return invalid(path);
    if (schema.oneOf) {
      var matches = 0, failure = null;
      for (var i = 0; i < schema.oneOf.length; i++) {
        var candidate = validateSchema(schema.oneOf[i], value, path);
        if (candidate.ok) matches++;
        else failure = candidate;
      }
      return matches === 1 ? { ok: true } : (failure || invalid(path));
    }
    if (value === null && schema.nullable === true) return { ok: true };
    if (schema.enum && schema.enum.indexOf(value) < 0) return invalid(path);
    if (schema.type === 'object') {
      if (!isPlainObject(value)) return invalid(path);
      var required = schema.required || [], props = schema.properties || {};
      for (var r = 0; r < required.length; r++) {
        if (!Object.prototype.hasOwnProperty.call(value, required[r])) return invalid(path + '.' + required[r]);
      }
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          if (schema.additionalProperties !== true) return invalid(path + '.' + key);
          continue;
        }
        var checkedProperty = validateSchema(props[key], value[key], path + '.' + key);
        if (!checkedProperty.ok) return checkedProperty;
      }
      return { ok: true };
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length < (schema.minItems || 0)
        || (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems)) return invalid(path);
      if (schema.uniqueItems === true) {
        var seenItems = Object.create(null);
        for (var u = 0; u < value.length; u++) {
          var itemKey;
          try { itemKey = JSON.stringify(value[u]); } catch (_) { return invalid(path + '[' + u + ']'); }
          if (seenItems[itemKey]) return invalid(path + '[' + u + ']');
          seenItems[itemKey] = true;
        }
      }
      if (schema.items) {
        for (var a = 0; a < value.length; a++) {
          var checkedItem = validateSchema(schema.items, value[a], path + '[' + a + ']');
          if (!checkedItem.ok) return checkedItem;
        }
      }
      return { ok: true };
    }
    if (schema.type === 'string') {
      if (typeof value !== 'string' || value.length < (schema.minLength || 0)
        || (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength)) return invalid(path);
      if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return invalid(path);
      return { ok: true };
    }
    if (schema.type === 'integer') {
      if (!Number.isSafeInteger(value) || (Number.isFinite(schema.minimum) && value < schema.minimum)
        || (Number.isFinite(schema.maximum) && value > schema.maximum)) return invalid(path);
      return { ok: true };
    }
    if (schema.type === 'boolean') return typeof value === 'boolean' ? { ok: true } : invalid(path);
    if (schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)
        || (Number.isFinite(schema.minimum) && value < schema.minimum)
        || (Number.isFinite(schema.maximum) && value > schema.maximum)) return invalid(path);
      return { ok: true };
    }
    return invalid(path);
  }

  var ACTION_MAP = Object.create(null);
  var LEGACY_MAP = Object.create(null);
  ACTIONS.forEach(function (action) {
    ACTION_MAP[action.actionId] = action;
    (action.legacyToolNames || []).forEach(function (name) { LEGACY_MAP[name] = action.actionId; });
  });
  function createRegistry() {
    return Object.freeze({
      actionIds: function () { return Object.keys(ACTION_MAP).sort(); },
      getDescriptor: function (actionId) { return ACTION_MAP[String(actionId || '')] || null; },
      resolveLegacyTool: function (toolName) { return LEGACY_MAP[String(toolName || '')] || null; },
      validateInput: function (actionId, input, caller) {
        var action = ACTION_MAP[String(actionId || '')];
        if (!action) return { ok: false, error: 'ACTION_NOT_REGISTERED', actionId: String(actionId || '') };
        caller = caller || 'runtime';
        if (caller !== 'runtime' && caller !== 'agent') return { ok: false, error: 'ACTION_CALLER_INVALID', actionId: action.actionId };
        if (caller === 'agent' && action.executionMode !== 'agent_request_dispatched') {
          return { ok: false, error: 'ACTION_EXECUTION_MODE_DENIED', actionId: action.actionId };
        }
        var checked = validateSchema(action.inputSchema, input, '$.input');
        if (checked.ok && action.actionId === 'ib.work.result.generate.v1' && input.mode === 'dsh') {
          if ((input.workflowId === 'app.builder' && input.plannedFileIds.length !== 0)
            || (input.workflowId === 'coding.workspace' && input.plannedFileIds.length === 0)) {
            checked = invalid('$.input.plannedFileIds');
          }
        }
        return checked.ok ? { ok: true, actionId: action.actionId, input: input }
          : { ok: false, error: 'ACTION_INPUT_INVALID', actionId: action.actionId, path: checked.path };
      },
      validateOutput: function (actionId, output) {
        var action = ACTION_MAP[String(actionId || '')];
        if (!action) return { ok: false, error: 'ACTION_NOT_REGISTERED', actionId: String(actionId || '') };
        var checked = validateSchema(action.outputSchema, output, '$.output');
        if (checked.ok && action.actionId === 'ib.work.plan.v1') {
          var planSeen = Object.create(null);
          output.steps.forEach(function (step, index) {
            if (planSeen[step.fileId]) checked = invalid('$.output.steps[' + index + '].fileId');
            planSeen[step.fileId] = true;
          });
        }
        if (checked.ok && action.actionId === 'ib.project.inspect.v1') {
          var inspectFileIds = Object.create(null), inspectPaths = Object.create(null);
          if (output.fileCount !== output.displayableFileCount + output.omittedFileCount
            || output.displayableFileCount !== output.files.length) {
            checked = invalid('$.output.fileCount');
          }
          output.files.forEach(function (file, index) {
            if (inspectFileIds[file.fileId]) checked = invalid('$.output.files[' + index + '].fileId');
            if (inspectPaths[file.path]) checked = invalid('$.output.files[' + index + '].path');
            inspectFileIds[file.fileId] = true;
            inspectPaths[file.path] = true;
          });
        }
        if (checked.ok && action.actionId === 'ib.result.compare.v1') {
          var metadataFields = Object.create(null);
          output.metadataDiff.forEach(function (item, index) {
            if (metadataFields[item.field] || item.sourceValue === item.targetValue) {
              checked = invalid('$.output.metadataDiff[' + index + '].field');
            }
            metadataFields[item.field] = true;
          });
          if (output.summary.sourceFindingCount - output.summary.removedFindings
            !== output.summary.targetFindingCount - output.summary.addedFindings
            || output.summary.removedFindings > output.summary.sourceFindingCount
            || output.summary.addedFindings > output.summary.targetFindingCount
            || output.summary.changedFindings > Math.min(
              output.summary.sourceFindingCount - output.summary.removedFindings,
              output.summary.targetFindingCount - output.summary.addedFindings
            )) {
            checked = invalid('$.output.summary');
          }
          if (output.statusChange.changed !== (output.statusChange.sourceRunStatus !== output.statusChange.targetRunStatus
            || output.statusChange.sourceResultStatus !== output.statusChange.targetResultStatus)) {
            checked = invalid('$.output.statusChange.changed');
          }
        }
        if (checked.ok && action.actionId === 'ib.work.review_result.v1'
          && ((output.decision === 'approve' && output.issueCodes.length !== 0)
            || (output.decision === 'revise' && output.issueCodes.length === 0))) {
          checked = invalid('$.output.issueCodes');
        }
        return checked.ok ? { ok: true, actionId: action.actionId, output: output }
          : { ok: false, error: 'ACTION_OUTPUT_INVALID', actionId: action.actionId, path: checked.path };
      }
    });
  }

  return Object.freeze({ registryVersion: 1, createRegistry: createRegistry, descriptors: ACTIONS });
});
