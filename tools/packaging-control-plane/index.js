'use strict';

const executor = require('./executor.js');

module.exports = {
  contract: require('./contract.js'),
  environmentInspector: require('./environment-inspector.js'),
  buildPlanner: require('./build-planner.js'),
  artifactValidator: require('./artifact-validator.js'),
  artifactManifestWriter: require('./artifact-manifest-writer.js'),
  packagingExecutor: {
    RESULT_SCHEMA: executor.RESULT_SCHEMA,
    STATES: executor.STATES,
    TERMINAL_STATES: executor.TERMINAL_STATES,
    checkStateTransition: executor.checkStateTransition,
    executePackagingJob: executor.executePackagingJob,
    cancelPackagingJob: executor.cancelPackagingJob,
    getPackagingJobState: executor.getPackagingJobState
  }
};
