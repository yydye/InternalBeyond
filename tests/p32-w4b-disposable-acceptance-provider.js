'use strict';

/* P32-W.4B · Disposable Acceptance Environment Provider.
 *
 * This module is deliberately a planner/discovery boundary. It never enables
 * Windows features, creates a VM, changes registry/shortcuts, starts an
 * installer, or falls back to the real user session. A future provider adapter
 * may consume the returned transfer plan inside a disposable Windows boundary.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROVIDER_IDS = Object.freeze({
  WINDOWS_SANDBOX: 'windows-sandbox',
  HYPER_V_VM: 'hyper-v-vm',
  CI_WINDOWS: 'ci-windows-runner'
});

function runPowerShellJson(script) {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    }).trim();
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function readHostFacts(options) {
  const o = options || {};
  if (typeof o.hostFacts === 'function') return o.hostFacts();
  if (process.platform !== 'win32') {
    return { platform: process.platform, features: {}, commands: {}, virtualization: {} };
  }
  const facts = runPowerShellJson(
    '$os=Get-CimInstance Win32_OperatingSystem;' +
    '$cs=Get-CimInstance Win32_ComputerSystem;' +
    '$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1;' +
    '$fs=@("Containers-DisposableClientVM","Microsoft-Hyper-V-All","VirtualMachinePlatform")|' +
    'ForEach-Object { try { $x=Get-WindowsOptionalFeature -Online -FeatureName $_ -ErrorAction Stop; ' +
    '[pscustomobject]@{name=$_;state=[string]$x.State;restart=[bool]$x.RestartRequired} } catch { ' +
    '[pscustomobject]@{name=$_;state="QUERY_FAILED";restart=$false} } };' +
    '$cmds=@("WindowsSandbox.exe","vmconnect.exe","VBoxManage.exe","qemu-system-x86_64.exe","docker.exe","wsl.exe")|' +
    'ForEach-Object { $c=Get-Command $_ -ErrorAction SilentlyContinue; ' +
    '[pscustomobject]@{name=$_;available=[bool]$c;path=if($c){$c.Source}else{$null}} };' +
    '[pscustomobject]@{' +
    'product=$os.Caption;version=$os.Version;build=$os.BuildNumber;' +
    'hypervisor=[bool]$cs.HypervisorPresent;firmware=[bool]$cpu.VirtualizationFirmwareEnabled;' +
    'slat=[bool]$cpu.SecondLevelAddressTranslationExtensions;' +
    'features=$fs;commands=$cmds' +
    '}|ConvertTo-Json -Depth 6 -Compress'
  );
  if (!facts) return { platform: process.platform, features: {}, commands: {}, virtualization: {} };
  const features = Object.fromEntries((facts.features || []).map(x => [x.name, x]));
  const commands = Object.fromEntries((facts.commands || []).map(x => [x.name, x]));
  return {
    platform: process.platform,
    product: facts.product,
    version: facts.version,
    build: facts.build,
    features,
    commands,
    virtualization: {
      hypervisor: facts.hypervisor === true,
      firmware: facts.firmware === true,
      slat: facts.slat === true
    }
  };
}

function discover(options) {
  const facts = readHostFacts(options);
  const sandboxFeature = facts.features && facts.features['Containers-DisposableClientVM'];
  const hyperVFeature = facts.features && facts.features['Microsoft-Hyper-V-All'];
  const commands = facts.commands || {};
  const sandboxAvailable = sandboxFeature && sandboxFeature.state === 'Enabled' &&
    commands['WindowsSandbox.exe'] && commands['WindowsSandbox.exe'].available === true &&
    facts.virtualization && facts.virtualization.firmware === true && facts.virtualization.slat === true;
  const hyperVAvailable = hyperVFeature && hyperVFeature.state === 'Enabled' &&
    commands['vmconnect.exe'] && commands['vmconnect.exe'].available === true &&
    facts.virtualization && facts.virtualization.firmware === true && facts.virtualization.slat === true;
  const dockerAvailable = !!(commands['docker.exe'] && commands['docker.exe'].available === true);
  const ciAvailable = options && options.ciWindowsRunner === true;
  const candidates = [
    {
      id: PROVIDER_IDS.WINDOWS_SANDBOX,
      available: !!sandboxAvailable,
      reason: sandboxAvailable ? 'Windows Sandbox is enabled and observable' : 'Windows Sandbox is unavailable or disabled',
      requiresHostMutation: !sandboxAvailable
    },
    {
      id: PROVIDER_IDS.HYPER_V_VM,
      available: !!hyperVAvailable,
      reason: hyperVAvailable ? 'Hyper-V disposable VM provider is observable' : 'Hyper-V/VM provider is unavailable or disabled',
      requiresHostMutation: !hyperVAvailable
    },
    {
      id: PROVIDER_IDS.CI_WINDOWS,
      available: !!ciAvailable,
      reason: ciAvailable ? 'Caller supplied an existing disposable Windows runner' : 'No existing disposable Windows CI runner was supplied',
      requiresHostMutation: false
    }
  ];
  const provider = candidates.find(candidate => candidate.available) || null;
  return {
    status: provider ? 'AVAILABLE' : 'BLOCKED_ENVIRONMENT',
    provider,
    candidates,
    facts: {
      product: facts.product || null,
      version: facts.version || null,
      build: facts.build || null,
      virtualization: facts.virtualization || {}
    }
  };
}

function artifactInfo(installerPath) {
  const file = path.resolve(String(installerPath || ''));
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return { ok: false, path: file, error: 'installer-artifact-missing' };
  }
  const stat = fs.statSync(file);
  const hash = crypto.createHash('sha256');
  const bytes = fs.readFileSync(file);
  hash.update(bytes);
  return { ok: true, path: file, size: stat.size, sha256: hash.digest('hex') };
}

function prepare(options) {
  const o = options || {};
  const discovery = discover(o);
  const artifact = artifactInfo(o.installerPath);
  const forbidden = (o.forbiddenRoots || []).map(value => path.resolve(String(value)));
  if (artifact.ok && forbidden.some(root => artifact.path === root || artifact.path.startsWith(root + path.sep))) {
    return { status: 'BLOCKED_ARTIFACT_SCOPE', discovery, artifact, error: 'installer artifact is inside a forbidden root' };
  }
  return {
    status: discovery.status === 'AVAILABLE' && artifact.ok ? 'READY_FOR_PROVIDER' : discovery.status,
    discovery,
    artifact,
    transfer: {
      mode: 'read-only-input',
      source: artifact.path,
      verify: ['filename', 'size', 'sha256', 'PE ProductVersion'],
      destination: 'provider-owned disposable Windows input root'
    },
    isolation: {
      registry: 'provider-owned HKCU/identity',
      shortcuts: 'provider-owned Desktop and Start Menu',
      appData: 'provider-owned APPDATA/LOCALAPPDATA/TEMP/TMP',
      ports: 'provider-owned loopback ports',
      installRoot: 'provider-owned disposable install root',
      data: 'synthetic fixtures only'
    },
    execution: 'not-started'
  };
}

function execute(options) {
  const plan = prepare(options);
  /* Execution is intentionally not implicit. A future disposable provider
     adapter must be injected by an explicitly approved BG2 runner. */
  return Object.assign({}, plan, {
    status: plan.status === 'READY_FOR_PROVIDER' ? 'NOT_EXECUTED' : plan.status,
    execution: 'not-started',
    reason: 'no disposable provider execution adapter was invoked'
  });
}

module.exports = {
  PROVIDER_IDS,
  discover,
  artifactInfo,
  prepare,
  execute
};
