'use strict';

/* Local-only visual fixture for agent-browser. It cannot execute a real build. */
const path = require('path');
const { createWebServer } = require('../services/internal-beyond-server.js');
const contract = require('../tools/packaging-control-plane/contract.js');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.IB_WEB_PORT || 43139);
const fakeControlPlane = {
  contract: contract,
  environmentInspector: {
    inspectEnvironment: function () {
      return {
        ready: true,
        repository: { revision: 'a'.repeat(40), dirty: false },
        checks: [
          { name: 'target', status: 'PASS', required: true },
          { name: 'operating-system', status: 'PASS', required: true },
          { name: 'node', status: 'PASS', required: true },
          { name: 'rustc', status: 'PASS', required: true },
          { name: 'cargo', status: 'PASS', required: true },
          { name: 'powershell', status: 'PASS', required: true },
          { name: 'inno-setup', status: 'PASS', required: true },
          { name: 'git-cleanliness', status: 'PASS', required: false }
        ]
      };
    }
  },
  buildPlanner: {
    createBuildPlan: function () {
      return {
        status: 'READY',
        executes: false,
        releaseEligible: true,
        steps: [
          { id: 'environment-check', status: 'PASS' },
          { id: 'prepare-staging', status: 'PLANNED' },
          { id: 'stage-tauri-host', status: 'PLANNED' },
          { id: 'audit-staged-payload', status: 'PLANNED' },
          { id: 'compile-inno-installer', status: 'PLANNED' },
          { id: 'build-installer', status: 'PLANNED' },
          { id: 'validate-artifact', status: 'PLANNED' }
        ]
      };
    }
  },
  packagingExecutor: {
    executePackagingJob: function () { throw new Error('VISUAL_FIXTURE_MUST_NOT_EXECUTE'); },
    getPackagingJobState: function () { return null; },
    cancelPackagingJob: function () { return Promise.resolve({ status: 'DENIED', code: 'INVALID_REQUEST' }); }
  }
};

const server = createWebServer({ root: root, port: port, packagingControlPlane: fakeControlPlane });
server.listen(server.port, server.host, function () {
  process.stdout.write('PACKAGING_VISUAL_FIXTURE_READY ' + server.port + '\n');
});
server.on('error', function (error) {
  process.stderr.write('PACKAGING_VISUAL_FIXTURE_FAILED ' + String(error && error.code || 'SERVER_ERROR') + '\n');
  process.exitCode = 1;
});
process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
