mod project_knowledge;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use project_knowledge::{
    list_project_docs, project_knowledge_status, read_project_doc, search_project_docs,
    ProjectKnowledgeState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const DEFAULT_RESTART_PORT: u16 = 23116;
const RUNTIME_MODE_ENV: &str = "IB_RUNTIME_MODE";
const RUNTIME_ROOT_CLASS_ENV: &str = "IB_RUNTIME_ROOT_CLASS";
const ACCEPTANCE_ROOT_ENV: &str = "IB_ACCEPTANCE_ROOT";
const PAYLOAD_MANIFEST: &str = "ib-payload-manifest.json";
const RECOVERY_ONLY_ARG: &str = "--recovery-only";
const C35_RECONSTRUCTION_DRY_RUN_ARG: &str = "--p32w5-r3c3-c3.5-production-dry-run";
const C35_CHILD_PROBE_REQUEST_SCHEMA: &str = "internalbeyond.p32-w5.r3-c3.5-child-process-boundary-probe-request";
const C35_CHILD_PROBE_SCRIPT_RELATIVE_PATH: &str = "services/home-node/c35 child boundary probe 子进程.js";
const C35_NODE_ENTRY_MARKER: &str = "C35_NODE_ENTRY_REACHED";
const C35_RECONSTRUCTION_DRY_RUN_SCHEMA: &str = "internalbeyond.p32-w5.r3-c3.5-recovery-only-dry-run-request";
const C35_RECONSTRUCTION_DRY_RUN_REQUEST_VERSION: u8 = 1;
const C35_UI_DRY_RUN_REQUEST_SCHEMA: &str = "internalbeyond.p32-w5.r3-c3.5-ui-dry-run-request";
const C35_RECONSTRUCTION_REPORT_SCHEMA: &str = "internalbeyond.p32-w5.r3-c3.5-production-reconstruction-dry-run";
const C35_RECONSTRUCTION_REPORT_TYPE: &str = "PRODUCTION_RECONSTRUCTION_DRY_RUN";
const C35_REPORT_MAX_BYTES: usize = 512 * 1024;
const C35_BUNDLE_ID: &str = "p32w5-r3c3:73527c524f091a8a44374090";
const C35_BUNDLE_SHA256: &str = "73527c524f091a8a4437409069979c2141f03b7048f8a042ae912c645e33bf7d";
const C35_WRITE_SET_A_SHA256: &str = "c12255e8483c090ba53d15f711da63b6579a78721010e7a1aedc73b50dd916cf";
const C35_WRITE_SET_B_SHA256: &str = "5823cbfd64defc58e05f89c75bde3e8dd92c853d51cf5c71a7a32fe3035e2062";
const C35_PLAN_ID: &str = "r3b3:1ee6aba8f773b8297e25a3904bad0f9db51ec308e4d295a1718ae48912cf44c7";
const C35_PLAN_SHA256: &str = "1ee6aba8f773b8297e25a3904bad0f9db51ec308e4d295a1718ae48912cf44c7";
const C35_TARGET_SNAPSHOT_SHA256: &str = "e353295cdb6d2c8bdd344b2b54bf4f5da59bbf7b2b85081380faefe022c76d9c";
const C35_SOURCE_PRIMARY_SHA256: &str = "1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401";
const C35_PROVENANCE_DIGEST: &str = "420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5";
const C35_AUTHORITY_MATRIX_SHA256: &str = "3d541b2bafd6d3adcb57b7a9a131d89d07b4f104ad3d1a77b86ebea53357411f";
const C35_CONFLICT_RESOLUTION_SHA256: &str = "957017349fab91012c7d6a064ea5f6a740d11c4a2b1cf68a7b74c28b3d1b0876";
const C35_C2_REPORT_SHA256: &str = "e2168acd3c998eb89ccee0184ce07d2a5b16d353782f27937d24c1989cccc2a7";
const C35_HOME_NODE_TARGET_RELATIVE_PATH: &str = "InternalBeyond\\home-node\\home-node.db";
const C35_HOME_NODE_TARGET_SHA256: &str = "eaad098dccfc21835a0b079da03d28f4323fc977abfe94a289d8aeb471c18276";
const PRODUCTION_RESTORE_ENABLED: bool = false;
const APPROVED_RECOVERY_SOURCE_SHA256: &str =
    "1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401";
const APPROVED_RECOVERY_SOURCE_SIZE: u64 = 45_062_434;
const APPROVED_RECOVERY_EXPORT_VERSION: u32 = 8;
const RECOVERY_CHECKPOINT_SCHEMA: &str = "internalbeyond.recovery-checkpoint";
const RECOVERY_CHECKPOINT_LIFECYCLE_SCHEMA: &str = "internalbeyond.recovery-checkpoint-lifecycle";
const RECOVERY_CONSUMED_SCHEMA: &str = "internalbeyond.recovery-first-boot-consumed";
const RECOVERY_FINALIZED_SCHEMA: &str = "internalbeyond.recovery-finalized";
const RECOVERY_FINALIZE_PHRASE: &str = "RECOVERY_FINALIZE";
const RECOVERY_APPROVAL_PHRASE: &str = "执行 R3-B.3 production restore";
const RECOVERY_APPROVAL_KIND: &str = "EXPLICIT_PRODUCTION_RESTORE_APPROVAL";
const APPROVED_RECOVERY_ROLE_SOURCE_SHA256: &str =
    "37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d";
const APPROVED_RECOVERY_MEMORY_SOURCE_SHA256: &str =
    "5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84";
const APPROVED_FROZEN_PLAN_ID: &str = "p32-w5-r3b3-p5.5:f99b6f236ecd78d3c111d106";
const APPROVED_FROZEN_PLAN_SHA256: &str =
    "f99b6f236ecd78d3c111d106d3c1714b9790f65f09c34937de62ba21a9aea117";
const APPROVED_FROZEN_ARTIFACT_SHA256: &str =
    "5b8431c9899a820ceaf4e3e5533110aac9fca7542fa2d6f5380991f4b89e22a4";
const APPROVED_AUTHORITY_TYPE: &str = "USER_CONFIRMED_IDENTITY_SUCCESSION";
const APPROVED_AUTHORITY_STATUS: &str = "EXPLICIT_USER_CONFIRMATION";
const APPROVED_AUTHORITY_REVISION_ID: &str = "p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca";
const APPROVED_AUTHORITY_REVISION_SHA256: &str =
    "f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7";
const APPROVED_PROVENANCE_COUNT: u64 = 539;
const APPROVED_PROVENANCE_SHA256: &str =
    "420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostEntryMode {
    Normal,
    RecoveryOnly,
}

fn host_entry_mode(args: impl IntoIterator<Item = std::ffi::OsString>) -> HostEntryMode {
    if args
        .into_iter()
        .any(|arg| arg.to_string_lossy() == RECOVERY_ONLY_ARG)
    {
        HostEntryMode::RecoveryOnly
    } else {
        HostEntryMode::Normal
    }
}

fn args_request_recovery_only(args: &[String]) -> bool {
    args.iter().any(|arg| arg == RECOVERY_ONLY_ARG)
}

fn args_request_c35_dry_run(args: &[String]) -> bool {
    args.iter().any(|arg| arg == C35_RECONSTRUCTION_DRY_RUN_ARG)
}

fn host_requests_c35_dry_run(args: &[String]) -> bool {
    args_request_recovery_only(args) && args_request_c35_dry_run(args)
}

fn host_starts_normal_services(mode: HostEntryMode) -> bool {
    mode == HostEntryMode::Normal
}

fn recovery_payload_is_complete(root: &Path) -> Result<(), String> {
    for relative in [
        "Recovery.html",
        "assets/js/webcore-db-schema.js",
        "assets/js/recovery-engine.js",
        "assets/js/composite-recovery-plan.js",
        "assets/js/recovery-webcore-adapter.js",
        "assets/js/recovery-production-adapter.js",
        "assets/js/recovery-apply-executor.js",
        "assets/js/recovery-first-boot.js",
        "assets/js/recovery-source-manifest.js",
        "assets/js/recovery-ui.js",
        "assets/js/recovery-shell.js",
        "assets/js/recovery-c3-5-reconstruction.js",
        "services/home-node/reconstruction-runner.js",
        "services/home-node/production-reconstruction-adapter.js",
        "services/home-node/composite-reconstruction-executor.js",
        "services/home-node/composite-reconstruction-approval.js",
        "services/home-node/character-projection-store.js",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/composite-bundle.json",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-reconstruction-write-set.json",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/character-projection-write-set.json",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-proposed-write-set.json",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/character-field-authority-matrix.json",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/character-conflict-resolution.json",
        "services/home-node/reconstruction-contracts/p32-w5-r3c3/c2-authority-report.json",
    ] {
        if !root.join(relative).is_file() {
            return Err(format!(
                "RECOVERY_PAYLOAD_INVALID: required file is missing: {relative}"
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryStoreSnapshot {
    name: String,
    count: usize,
    keys: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryPlannedWrite {
    store: String,
    key: String,
    record_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCheckpoint {
    schema: String,
    version: u8,
    phase: String,
    plan_id: String,
    plan_hash: String,
    frozen_plan_id: String,
    frozen_plan_hash: String,
    frozen_artifact_sha256: String,
    transaction_id: String,
    #[serde(default)]
    lifecycle_id: String,
    integrity_sha256: String,
    source_sha256: String,
    source_size: u64,
    export_version: u32,
    supplemental_role_source_sha256: String,
    supplemental_memory_source_sha256: String,
    authority_type: String,
    authority_status: String,
    authority_revision_id: String,
    authority_revision_sha256: String,
    provenance_digest: String,
    provenance_record_count: u64,
    target_snapshot_sha256: String,
    execution_phase: String,
    target_origin: String,
    target_identity: String,
    database_name: String,
    schema_version: u32,
    selected_domains: Vec<String>,
    stores: Vec<String>,
    before_stores: Vec<RecoveryStoreSnapshot>,
    planned_writes: Vec<RecoveryPlannedWrite>,
    first_boot_pending: bool,
    active_quarantined: bool,
    created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExplicitRestoreApproval {
    kind: String,
    confirmation: String,
    token: String,
    lifecycle_id: String,
    plan_id: String,
    plan_hash: String,
    frozen_plan_id: String,
    frozen_plan_hash: String,
    frozen_artifact_sha256: String,
    transaction_id: String,
    source_sha256: String,
    source_size: u64,
    export_version: u32,
    supplemental_role_source_sha256: String,
    supplemental_memory_source_sha256: String,
    authority_type: String,
    authority_status: String,
    authority_revision_id: String,
    authority_revision_sha256: String,
    provenance_digest: String,
    provenance_record_count: u64,
    target_snapshot_sha256: String,
    execution_phase: String,
    target_origin: String,
    target_identity: String,
    database_name: String,
    schema_version: u32,
    selected_domains: Vec<String>,
    expires_at: u64,
}

static USED_RECOVERY_APPROVALS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ISSUED_RECOVERY_APPROVALS: OnceLock<Mutex<HashMap<String, IssuedRecoveryApproval>>> =
    OnceLock::new();
static ACTIVE_RECOVERY_APPLY_WINDOW: OnceLock<Mutex<Option<ActiveRecoveryApplyWindow>>> =
    OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryApprovalBinding {
    plan_id: String,
    plan_hash: String,
    frozen_plan_id: String,
    frozen_plan_hash: String,
    frozen_artifact_sha256: String,
    transaction_id: String,
    source_sha256: String,
    source_size: u64,
    export_version: u32,
    supplemental_role_source_sha256: String,
    supplemental_memory_source_sha256: String,
    authority_type: String,
    authority_status: String,
    authority_revision_id: String,
    authority_revision_sha256: String,
    provenance_digest: String,
    provenance_record_count: u64,
    target_snapshot_sha256: String,
    execution_phase: String,
    target_origin: String,
    target_identity: String,
    database_name: String,
    schema_version: u32,
    selected_domains: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCheckpointLifecycle {
    schema: String,
    version: u8,
    phase: String,
    lifecycle_id: String,
    binding: RecoveryApprovalBinding,
    checkpoint_integrity_sha256: String,
    checkpoint_file_sha256: String,
    created_at: String,
    record_sha256: String,
}

#[derive(Clone, Debug)]
struct IssuedRecoveryApproval {
    binding: RecoveryApprovalBinding,
    expires_at: u64,
    checkpoint_written: bool,
    lifecycle_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryApprovalIssueRequest {
    kind: String,
    confirmation: String,
    entered_plan_id: String,
    entered_plan_hash: String,
    plan: RecoveryApprovalBinding,
}

#[derive(Clone, Debug)]
struct ActiveRecoveryApplyWindow {
    binding: RecoveryApprovalBinding,
    token: String,
    expires_at: u64,
}

#[derive(Clone, Debug)]
struct RecoveryOnlyHostState {
    target_identity: String,
    target_origin: String,
    active_quarantined: bool,
    reconstruction_dry_run_only: bool,
}

#[derive(Default)]
struct RecoveryOnlyLifecycleState {
    active_dry_runs: usize,
    last_window_destroyed: bool,
    shutdown_pending: bool,
    exit_requested: bool,
}

#[derive(Default)]
struct RecoveryOnlyLifecycle {
    state: Mutex<RecoveryOnlyLifecycleState>,
}

impl RecoveryOnlyLifecycle {
    fn begin_dry_run(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.last_window_destroyed || state.shutdown_pending || state.exit_requested {
            return Err("C35_RECOVERYONLY_HOST_CLOSING".to_string());
        }
        state.active_dry_runs = state
            .active_dry_runs
            .checked_add(1)
            .ok_or_else(|| "C35_DRYRUN_ACTIVITY_OVERFLOW".to_string())?;
        Ok(())
    }

    fn finish_dry_run(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_dry_runs == 0 {
            return false;
        }
        state.active_dry_runs -= 1;
        Self::request_exit_if_ready(&mut state)
    }

    fn recovery_window_destroyed(&self, is_last_window: bool) -> bool {
        if !is_last_window {
            return false;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.last_window_destroyed = true;
        state.shutdown_pending = true;
        Self::request_exit_if_ready(&mut state)
    }

    fn defer_exit_while_dry_run_active(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.exit_requested || state.active_dry_runs == 0 {
            return false;
        }
        state.shutdown_pending = true;
        true
    }

    fn request_exit_if_ready(state: &mut RecoveryOnlyLifecycleState) -> bool {
        if (state.last_window_destroyed || state.shutdown_pending)
            && state.active_dry_runs == 0
            && !state.exit_requested
        {
            state.exit_requested = true;
            return true;
        }
        false
    }
}

struct RecoveryOnlyDryRunGuard<'a> {
    lifecycle: &'a RecoveryOnlyLifecycle,
    app: tauri::AppHandle,
}

impl<'a> RecoveryOnlyDryRunGuard<'a> {
    fn begin(lifecycle: &'a RecoveryOnlyLifecycle, app: tauri::AppHandle) -> Result<Self, String> {
        lifecycle.begin_dry_run()?;
        Ok(Self { lifecycle, app })
    }
}

impl Drop for RecoveryOnlyDryRunGuard<'_> {
    fn drop(&mut self) {
        if self.lifecycle.finish_dry_run() {
            self.app.exit(0);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryApplyWindowRequest {
    approval: ExplicitRestoreApproval,
    plan: RecoveryApprovalBinding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryApplyWindowCloseRequest {
    plan_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCheckpointWriteRequest {
    checkpoint: RecoveryCheckpoint,
    approval: ExplicitRestoreApproval,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCheckpointAbortRequest {
    approval: ExplicitRestoreApproval,
    plan: RecoveryApprovalBinding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryPlanRequest {
    plan_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRollbackClearRequest {
    plan_id: String,
    rollback_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryFirstBootConsumed {
    schema: String,
    version: u8,
    plan_id: String,
    consumed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryFinalizeRequest {
    plan_id: String,
    credential_ready_digest: String,
    confirmation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryFinalizedMarker {
    schema: String,
    version: u8,
    plan_id: String,
    lifecycle_id: String,
    checkpoint_file_sha256: String,
    verified_at: String,
    credential_ready_digest: String,
    authorized_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryBootMode {
    Normal,
    FirstBootPending,
    ActiveQuarantine,
    Blocked,
}

#[derive(Clone, Debug)]
struct RecoveryBootPolicy {
    mode: RecoveryBootMode,
    plan_id: Option<String>,
}

impl RecoveryBootPolicy {
    fn normal() -> Self {
        Self {
            mode: RecoveryBootMode::Normal,
            plan_id: None,
        }
    }

    fn suppress_services(&self) -> bool {
        self.mode != RecoveryBootMode::Normal
    }

    fn first_boot_pending(&self) -> bool {
        self.mode == RecoveryBootMode::FirstBootPending
    }

    fn active_quarantined(&self) -> bool {
        self.mode != RecoveryBootMode::Normal
    }

    fn blocked(&self) -> bool {
        self.mode == RecoveryBootMode::Blocked
    }
}

const RECOVERY_DOMAINS: &[&str] = &[
    "apiConfigs",
    "chatMessages",
    "chatThreads",
    "groups",
    "memories",
    "autoMemory",
    "diary_entries",
    "moments",
    "roleLetters",
];

const RECOVERY_DOMAIN_COUNTS: &[(&str, usize)] = &[
    ("apiConfigs", 13),
    ("chatMessages", 341),
    ("chatThreads", 2),
    ("groups", 7),
    ("memories", 4),
    ("autoMemory", 3),
    ("diary_entries", 13),
    ("moments", 155),
    ("roleLetters", 1),
];

/* All plan, approval, checkpoint, token, and lifecycle domain vectors share
this exact scope rule and bytewise ordering. Duplicate entries are rejected
before sorting so normalization cannot conceal a changed restore scope. */
fn canonical_recovery_domains(domains: &[String]) -> Result<Vec<String>, &'static str> {
    let mut seen = BTreeSet::new();
    for domain in domains {
        if !RECOVERY_DOMAINS.contains(&domain.as_str()) {
            return Err("RECOVERY_DOMAIN_UNKNOWN");
        }
        if !seen.insert(domain.as_str()) {
            return Err("RECOVERY_DOMAIN_DUPLICATE");
        }
    }
    let mut canonical = domains.to_vec();
    canonical.sort();
    let mut required: Vec<String> = RECOVERY_DOMAINS
        .iter()
        .map(|domain| domain.to_string())
        .collect();
    required.sort();
    if canonical != required {
        return Err("RECOVERY_DOMAIN_SCOPE_MISMATCH");
    }
    Ok(canonical)
}

fn canonicalize_recovery_binding_domains(
    binding: &mut RecoveryApprovalBinding,
) -> Result<(), String> {
    binding.selected_domains = canonical_recovery_domains(&binding.selected_domains)
        .map_err(|_| "APPROVAL_BINDING_SELECTED_DOMAINS_MISMATCH".to_string())?;
    Ok(())
}

fn recovery_bindings_canonically_equal(
    left: &RecoveryApprovalBinding,
    right: &RecoveryApprovalBinding,
) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    canonicalize_recovery_binding_domains(&mut left).is_ok()
        && canonicalize_recovery_binding_domains(&mut right).is_ok()
        && left == right
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_canonical_tauri_origin(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let host = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    host.map(|value| {
        value == "tauri.localhost"
            || value
                .strip_prefix("tauri.localhost:")
                .map(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false)
    })
    .unwrap_or(false)
}

fn is_canonical_install_identity(value: &str) -> bool {
    let parts: Vec<&str> = value.split('|').collect();
    parts.len() == 5
        && parts[0] == "com.internalbeyond.desktop"
        && parts[1] == "canonical-inno"
        && parts[2].contains(':')
        && !parts[2].contains("|tmp|")
        && parts[3].split('.').count() == 3
        && parts[3]
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
        && is_sha256(parts[4])
}

fn recovery_approval_authority_invalid_reason(
    binding: &RecoveryApprovalBinding,
) -> Option<&'static str> {
    if binding.authority_type == APPROVED_AUTHORITY_TYPE {
        if binding.authority_status != APPROVED_AUTHORITY_STATUS {
            return Some("APPROVAL_BINDING_AUTHORITY_STATUS_MISMATCH");
        }
        if binding.authority_revision_id != APPROVED_AUTHORITY_REVISION_ID {
            return Some("APPROVAL_BINDING_AUTHORITY_REVISION_ID_MISMATCH");
        }
        if binding.authority_revision_sha256 != APPROVED_AUTHORITY_REVISION_SHA256 {
            return Some("APPROVAL_BINDING_AUTHORITY_REVISION_SHA256_MISMATCH");
        }
        return None;
    }
    if binding.authority_type == "USER_ASSERTED" {
        if binding.authority_status != "EXPLICIT_USER_ASSERTION" {
            return Some("APPROVAL_BINDING_AUTHORITY_STATUS_MISMATCH");
        }
        if !binding.authority_revision_id.is_empty() {
            return Some("APPROVAL_BINDING_AUTHORITY_REVISION_ID_MISMATCH");
        }
        if !binding.authority_revision_sha256.is_empty() {
            return Some("APPROVAL_BINDING_AUTHORITY_REVISION_SHA256_MISMATCH");
        }
        return None;
    }
    Some("APPROVAL_BINDING_AUTHORITY_TYPE_MISMATCH")
}

fn recovery_approval_binding_invalid_reason(
    binding: &RecoveryApprovalBinding,
) -> Option<&'static str> {
    if !is_sha256(&binding.plan_hash) {
        return Some("APPROVAL_BINDING_PLAN_HASH_INVALID");
    }
    if binding.plan_id != format!("r3b3:{}", binding.plan_hash) {
        return Some("APPROVAL_BINDING_PLAN_ID_MISMATCH");
    }
    if binding.transaction_id != format!("r3b3-tx:{}", binding.plan_hash) {
        return Some("APPROVAL_BINDING_TRANSACTION_ID_MISMATCH");
    }
    if binding.frozen_plan_id != APPROVED_FROZEN_PLAN_ID {
        return Some("APPROVAL_BINDING_FROZEN_PLAN_ID_MISMATCH");
    }
    if binding.frozen_plan_hash != APPROVED_FROZEN_PLAN_SHA256 {
        return Some("APPROVAL_BINDING_FROZEN_PLAN_HASH_MISMATCH");
    }
    if binding.frozen_artifact_sha256 != APPROVED_FROZEN_ARTIFACT_SHA256 {
        return Some("APPROVAL_BINDING_FROZEN_ARTIFACT_SHA256_MISMATCH");
    }
    if binding.source_sha256 != APPROVED_RECOVERY_SOURCE_SHA256 {
        return Some("APPROVAL_BINDING_SOURCE_SHA256_MISMATCH");
    }
    if binding.source_size != APPROVED_RECOVERY_SOURCE_SIZE {
        return Some("APPROVAL_BINDING_SOURCE_SIZE_MISMATCH");
    }
    if binding.export_version != APPROVED_RECOVERY_EXPORT_VERSION {
        return Some("APPROVAL_BINDING_EXPORT_VERSION_MISMATCH");
    }
    if binding.supplemental_role_source_sha256 != APPROVED_RECOVERY_ROLE_SOURCE_SHA256 {
        return Some("APPROVAL_BINDING_ROLE_SOURCE_SHA256_MISMATCH");
    }
    if binding.supplemental_memory_source_sha256 != APPROVED_RECOVERY_MEMORY_SOURCE_SHA256 {
        return Some("APPROVAL_BINDING_MEMORY_SOURCE_SHA256_MISMATCH");
    }
    if let Some(reason) = recovery_approval_authority_invalid_reason(binding) {
        return Some(reason);
    }
    if binding.provenance_digest != APPROVED_PROVENANCE_SHA256 {
        return Some("APPROVAL_BINDING_PROVENANCE_DIGEST_MISMATCH");
    }
    if binding.provenance_record_count != APPROVED_PROVENANCE_COUNT {
        return Some("APPROVAL_BINDING_PROVENANCE_COUNT_MISMATCH");
    }
    if !is_sha256(&binding.target_snapshot_sha256) {
        return Some("APPROVAL_BINDING_TARGET_SNAPSHOT_SHA256_INVALID");
    }
    if binding.execution_phase != "R3-B.3" {
        return Some("APPROVAL_BINDING_EXECUTION_PHASE_MISMATCH");
    }
    if binding.database_name != "InternalBeyondDB" {
        return Some("APPROVAL_BINDING_DATABASE_NAME_MISMATCH");
    }
    if binding.schema_version != 24 {
        return Some("APPROVAL_BINDING_SCHEMA_VERSION_MISMATCH");
    }
    if !is_canonical_tauri_origin(&binding.target_origin) {
        return Some("APPROVAL_BINDING_TARGET_ORIGIN_INVALID");
    }
    if canonical_recovery_domains(&binding.selected_domains).is_err() {
        return Some("APPROVAL_BINDING_SELECTED_DOMAINS_MISMATCH");
    }
    if !is_canonical_install_identity(&binding.target_identity) {
        return Some("APPROVAL_BINDING_TARGET_IDENTITY_INVALID");
    }
    None
}

fn recovery_approval_binding_is_pinned(binding: &RecoveryApprovalBinding) -> bool {
    recovery_approval_binding_invalid_reason(binding).is_none()
}

fn approval_token_binding_mismatch_reason(
    approval: &ExplicitRestoreApproval,
    binding: &RecoveryApprovalBinding,
) -> Option<&'static str> {
    macro_rules! exact_mismatch {
        ($field:ident, $reason:literal) => {
            if approval.$field != binding.$field {
                return Some($reason);
            }
        };
    }
    macro_rules! hash_mismatch {
        ($field:ident, $reason:literal) => {
            if !approval.$field.eq_ignore_ascii_case(&binding.$field) {
                return Some($reason);
            }
        };
    }
    exact_mismatch!(plan_id, "APPROVAL_TOKEN_PLAN_ID_MISMATCH");
    hash_mismatch!(plan_hash, "APPROVAL_TOKEN_PLAN_HASH_MISMATCH");
    exact_mismatch!(frozen_plan_id, "APPROVAL_TOKEN_FROZEN_PLAN_ID_MISMATCH");
    hash_mismatch!(frozen_plan_hash, "APPROVAL_TOKEN_FROZEN_PLAN_HASH_MISMATCH");
    hash_mismatch!(
        frozen_artifact_sha256,
        "APPROVAL_TOKEN_FROZEN_ARTIFACT_SHA256_MISMATCH"
    );
    exact_mismatch!(transaction_id, "APPROVAL_TOKEN_TRANSACTION_ID_MISMATCH");
    hash_mismatch!(source_sha256, "APPROVAL_TOKEN_SOURCE_SHA256_MISMATCH");
    exact_mismatch!(source_size, "APPROVAL_TOKEN_SOURCE_SIZE_MISMATCH");
    exact_mismatch!(export_version, "APPROVAL_TOKEN_EXPORT_VERSION_MISMATCH");
    hash_mismatch!(
        supplemental_role_source_sha256,
        "APPROVAL_TOKEN_ROLE_SOURCE_SHA256_MISMATCH"
    );
    hash_mismatch!(
        supplemental_memory_source_sha256,
        "APPROVAL_TOKEN_MEMORY_SOURCE_SHA256_MISMATCH"
    );
    exact_mismatch!(authority_type, "APPROVAL_TOKEN_AUTHORITY_TYPE_MISMATCH");
    exact_mismatch!(authority_status, "APPROVAL_TOKEN_AUTHORITY_STATUS_MISMATCH");
    exact_mismatch!(
        authority_revision_id,
        "APPROVAL_TOKEN_AUTHORITY_REVISION_ID_MISMATCH"
    );
    hash_mismatch!(
        authority_revision_sha256,
        "APPROVAL_TOKEN_AUTHORITY_REVISION_SHA256_MISMATCH"
    );
    hash_mismatch!(
        provenance_digest,
        "APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH"
    );
    exact_mismatch!(
        provenance_record_count,
        "APPROVAL_TOKEN_PROVENANCE_COUNT_MISMATCH"
    );
    hash_mismatch!(
        target_snapshot_sha256,
        "APPROVAL_TOKEN_TARGET_SNAPSHOT_SHA256_MISMATCH"
    );
    exact_mismatch!(execution_phase, "APPROVAL_TOKEN_EXECUTION_PHASE_MISMATCH");
    exact_mismatch!(target_origin, "APPROVAL_TOKEN_TARGET_ORIGIN_MISMATCH");
    exact_mismatch!(target_identity, "APPROVAL_TOKEN_TARGET_IDENTITY_MISMATCH");
    exact_mismatch!(database_name, "APPROVAL_TOKEN_DATABASE_NAME_MISMATCH");
    exact_mismatch!(schema_version, "APPROVAL_TOKEN_SCHEMA_VERSION_MISMATCH");
    let approved_domains = canonical_recovery_domains(&approval.selected_domains);
    let bound_domains = canonical_recovery_domains(&binding.selected_domains);
    if !matches!((approved_domains, bound_domains), (Ok(approved), Ok(bound)) if approved == bound)
    {
        return Some("APPROVAL_TOKEN_SELECTED_DOMAINS_MISMATCH");
    }
    None
}

fn issued_binding_mismatch_code(
    issued: &RecoveryApprovalBinding,
    requested: &RecoveryApprovalBinding,
) -> Option<String> {
    macro_rules! exact_mismatch {
        ($field:ident, $label:literal) => {
            if issued.$field != requested.$field {
                return Some(format!("APPROVAL_ISSUED_BINDING_{}_MISMATCH", $label));
            }
        };
    }
    exact_mismatch!(plan_id, "PLAN_ID");
    exact_mismatch!(plan_hash, "PLAN_HASH");
    exact_mismatch!(frozen_plan_id, "FROZEN_PLAN_ID");
    exact_mismatch!(frozen_plan_hash, "FROZEN_PLAN_HASH");
    exact_mismatch!(frozen_artifact_sha256, "FROZEN_ARTIFACT_SHA256");
    exact_mismatch!(transaction_id, "TRANSACTION_ID");
    exact_mismatch!(source_sha256, "SOURCE_SHA256");
    exact_mismatch!(source_size, "SOURCE_SIZE");
    exact_mismatch!(export_version, "EXPORT_VERSION");
    exact_mismatch!(supplemental_role_source_sha256, "ROLE_SOURCE_SHA256");
    exact_mismatch!(supplemental_memory_source_sha256, "MEMORY_SOURCE_SHA256");
    exact_mismatch!(authority_type, "AUTHORITY_TYPE");
    exact_mismatch!(authority_status, "AUTHORITY_STATUS");
    exact_mismatch!(authority_revision_id, "AUTHORITY_REVISION_ID");
    exact_mismatch!(authority_revision_sha256, "AUTHORITY_REVISION_SHA256");
    exact_mismatch!(provenance_digest, "PROVENANCE_DIGEST");
    exact_mismatch!(provenance_record_count, "PROVENANCE_COUNT");
    exact_mismatch!(target_snapshot_sha256, "TARGET_SNAPSHOT_SHA256");
    exact_mismatch!(execution_phase, "EXECUTION_PHASE");
    exact_mismatch!(target_origin, "TARGET_ORIGIN");
    exact_mismatch!(target_identity, "TARGET_IDENTITY");
    exact_mismatch!(database_name, "DATABASE_NAME");
    exact_mismatch!(schema_version, "SCHEMA_VERSION");
    let issued_domains = canonical_recovery_domains(&issued.selected_domains);
    let requested_domains = canonical_recovery_domains(&requested.selected_domains);
    if !matches!((issued_domains, requested_domains), (Ok(issued), Ok(requested)) if issued == requested)
    {
        return Some("APPROVAL_ISSUED_BINDING_SELECTED_DOMAINS_MISMATCH".to_string());
    }
    None
}

fn validate_recovery_checkpoint(checkpoint: &RecoveryCheckpoint) -> Result<(), String> {
    let selected_domains = canonical_recovery_domains(&checkpoint.selected_domains)
        .map_err(|_| "RECOVERY_CHECKPOINT_DOMAIN_SET_INVALID".to_string())?;
    let canonical_stores = canonical_recovery_domains(&checkpoint.stores)
        .map_err(|_| "RECOVERY_CHECKPOINT_STORE_SET_INVALID".to_string())?;
    if selected_domains != canonical_stores {
        return Err("RECOVERY_CHECKPOINT_STORE_SET_INVALID".to_string());
    }
    let checkpoint_binding = approval_binding_from_checkpoint(checkpoint)?;
    if checkpoint.lifecycle_id.len() != 32
        || !checkpoint
            .lifecycle_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("RECOVERY_CHECKPOINT_LIFECYCLE_ID_INVALID".to_string());
    }
    if checkpoint.schema != RECOVERY_CHECKPOINT_SCHEMA
        || checkpoint.version != 1
        || checkpoint.phase != "PREPARED"
        || !recovery_approval_binding_is_pinned(&checkpoint_binding)
        || !is_sha256(&checkpoint.integrity_sha256)
        || !checkpoint
            .target_identity
            .starts_with("com.internalbeyond.desktop|canonical-inno|")
        || checkpoint.created_at.is_empty()
        || checkpoint.created_at.len() > 64
        || !checkpoint.first_boot_pending
        || !checkpoint.active_quarantined
    {
        return Err("RECOVERY_CHECKPOINT_INVALID".to_string());
    }
    let store_set: BTreeSet<String> = canonical_stores.into_iter().collect();
    let mut before = BTreeSet::new();
    for snapshot in &checkpoint.before_stores {
        if !store_set.contains(&snapshot.name)
            || snapshot.count != snapshot.keys.len()
            || snapshot.keys.len() > 20_000
            || !before.insert(snapshot.name.clone())
        {
            return Err("RECOVERY_CHECKPOINT_SNAPSHOT_INVALID".to_string());
        }
        let unique: BTreeSet<&String> = snapshot.keys.iter().collect();
        if unique.len() != snapshot.keys.len()
            || snapshot
                .keys
                .iter()
                .any(|key| key.is_empty() || key.len() > 256)
        {
            return Err("RECOVERY_CHECKPOINT_SNAPSHOT_INVALID".to_string());
        }
    }
    if before != store_set {
        return Err("RECOVERY_CHECKPOINT_SNAPSHOT_INVALID".to_string());
    }
    let mut planned = BTreeSet::new();
    for row in &checkpoint.planned_writes {
        if !store_set.contains(&row.store)
            || row.key.is_empty()
            || row.key.len() > 256
            || !is_sha256(&row.record_sha256)
            || !planned.insert((row.store.clone(), row.key.clone()))
        {
            return Err("RECOVERY_CHECKPOINT_WRITE_SET_INVALID".to_string());
        }
    }
    for (domain, expected_count) in RECOVERY_DOMAIN_COUNTS {
        if checkpoint
            .planned_writes
            .iter()
            .filter(|row| row.store == *domain)
            .count()
            != *expected_count
        {
            return Err("RECOVERY_CHECKPOINT_WRITE_SET_INVALID".to_string());
        }
    }
    if checkpoint.planned_writes.len() != APPROVED_PROVENANCE_COUNT as usize {
        return Err("RECOVERY_CHECKPOINT_WRITE_SET_INVALID".to_string());
    }
    let expected_integrity = recovery_checkpoint_integrity_sha256(checkpoint)?;
    if !expected_integrity.eq_ignore_ascii_case(&checkpoint.integrity_sha256) {
        return Err("RECOVERY_CHECKPOINT_INTEGRITY_INVALID".to_string());
    }
    Ok(())
}

fn recovery_checkpoint_integrity_sha256(checkpoint: &RecoveryCheckpoint) -> Result<String, String> {
    let mut value = serde_json::to_value(checkpoint)
        .map_err(|_| "RECOVERY_CHECKPOINT_SERIALIZE_FAILED".to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    object.remove("integritySha256");
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| "RECOVERY_CHECKPOINT_SERIALIZE_FAILED".to_string())?;
    Ok(sha256_hex(&bytes))
}

fn consume_restore_approval_token(
    token: &str,
    binding: &RecoveryApprovalBinding,
) -> Result<(), String> {
    let mut issued = issued_recovery_approval_registry()
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    let Some(record) = issued.get(token) else {
        let registry = USED_RECOVERY_APPROVALS.get_or_init(|| Mutex::new(HashSet::new()));
        let used = registry
            .lock()
            .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
        return if used.contains(token) {
            Err("APPROVAL_TOKEN_ALREADY_CONSUMED".to_string())
        } else {
            Err("APPROVAL_TOKEN_NOT_ISSUED_HERE".to_string())
        };
    };
    if record.expires_at <= current_unix_ms() {
        return Err("APPROVAL_TOKEN_EXPIRED".to_string());
    }
    if let Some(reason) = issued_binding_mismatch_code(&record.binding, binding) {
        return Err(reason);
    }
    if !record.checkpoint_written {
        return Err("APPROVAL_CHECKPOINT_NOT_MARKED_WRITTEN".to_string());
    }
    let registry = USED_RECOVERY_APPROVALS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut used = registry
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    if !used.insert(token.to_string()) {
        return Err("APPROVAL_TOKEN_ALREADY_CONSUMED".to_string());
    }
    issued.remove(token);
    Ok(())
}

fn validate_restore_approval(
    approval: &ExplicitRestoreApproval,
    binding: &RecoveryApprovalBinding,
) -> Result<(), String> {
    if approval.expires_at
        <= SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    {
        return Err("APPROVAL_TOKEN_EXPIRED".to_string());
    }
    if let Some(reason) = recovery_approval_binding_invalid_reason(binding) {
        return Err(reason.to_string());
    }
    if approval.kind != RECOVERY_APPROVAL_KIND {
        return Err("APPROVAL_TOKEN_KIND_MISMATCH".to_string());
    }
    if approval.confirmation != RECOVERY_APPROVAL_PHRASE {
        return Err("APPROVAL_TOKEN_CONFIRMATION_MISMATCH".to_string());
    }
    if approval.token.len() != 64 || !approval.token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("APPROVAL_TOKEN_FORMAT_INVALID".to_string());
    }
    if approval.lifecycle_id.len() != 32
        || !approval
            .lifecycle_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_INVALID".to_string());
    }
    if let Some(reason) = approval_token_binding_mismatch_reason(approval, binding) {
        return Err(reason.to_string());
    }
    Ok(())
}

fn issued_recovery_approval_registry() -> &'static Mutex<HashMap<String, IssuedRecoveryApproval>> {
    ISSUED_RECOVERY_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_recovery_approval_issue_request(
    request: &RecoveryApprovalIssueRequest,
    host: &RecoveryOnlyHostState,
    data_root: &Path,
) -> Result<(), String> {
    if PRODUCTION_RESTORE_ENABLED {
        return Err("APPROVAL_STATIC_APPLY_FLAG_INVALID".to_string());
    }
    if request.kind != RECOVERY_APPROVAL_KIND {
        return Err("APPROVAL_KIND_INVALID".to_string());
    }
    if request.confirmation != RECOVERY_APPROVAL_PHRASE {
        return Err("APPROVAL_CONFIRMATION_PHRASE_MISMATCH".to_string());
    }
    if request.entered_plan_id != request.plan.plan_id {
        return Err("APPROVAL_PLAN_MISMATCH".to_string());
    }
    if request.entered_plan_hash.to_ascii_lowercase() != request.plan.plan_hash.to_ascii_lowercase()
    {
        return Err("APPROVAL_HASH_MISMATCH".to_string());
    }
    if let Some(reason) = recovery_approval_authority_invalid_reason(&request.plan) {
        return Err(reason.to_string());
    }
    if let Some(reason) = recovery_approval_binding_invalid_reason(&request.plan) {
        return Err(reason.to_string());
    }
    if request.plan.target_identity != host.target_identity
        || request.plan.target_origin != host.target_origin
    {
        return Err("APPROVAL_TARGET_BINDING_MISMATCH".to_string());
    }
    if checkpoint_path(data_root).exists()
        || checkpoint_lifecycle_intent_path(data_root).exists()
        || checkpoint_lifecycle_ready_path(data_root).exists()
        || verified_marker_path(data_root).exists()
        || consumed_marker_path(data_root).exists()
    {
        return Err("APPROVAL_RECOVERY_STATE_BLOCKED".to_string());
    }
    Ok(())
}

fn native_approval_prompt_text(binding: &RecoveryApprovalBinding) -> String {
    format!(
        "Approve this one-time production business-data restore?\r\n\r\nPlan ID:\r\n{}\r\n\r\nProduction plan SHA-256:\r\n{}\r\n\r\nPrimary source SHA-256: {}\r\nRole source SHA-256: {}\r\nMemory source SHA-256: {}\r\nAuthority: {} / {}\r\nAuthority revision: {}\r\nProvenance: {} records / {}\r\nTarget: {}\r\nOrigin/database/schema: {} / {} / v{}\r\n\r\nChoose Yes only if these exact details match the RecoveryOnly screen.",
        binding.plan_id,
        binding.plan_hash,
        binding.source_sha256,
        binding.supplemental_role_source_sha256,
        binding.supplemental_memory_source_sha256,
        binding.authority_type,
        binding.authority_status,
        binding.authority_revision_id,
        binding.provenance_record_count,
        binding.provenance_digest,
        binding.target_identity,
        binding.target_origin,
        binding.database_name,
        binding.schema_version
    )
}

#[cfg(windows)]
fn confirm_native_restore_approval(
    owner: *mut std::ffi::c_void,
    binding: &RecoveryApprovalBinding,
) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn IsWindow(window: *mut std::ffi::c_void) -> i32;
        fn IsWindowVisible(window: *mut std::ffi::c_void) -> i32;
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
        fn SetForegroundWindow(window: *mut std::ffi::c_void) -> i32;
        fn GetWindowThreadProcessId(window: *mut std::ffi::c_void, process_id: *mut u32) -> u32;
        fn GetCurrentProcessId() -> u32;
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            flags: u32,
        ) -> i32;
    }

    if owner.is_null() || unsafe { IsWindow(owner) } == 0 || unsafe { IsWindowVisible(owner) } == 0
    {
        return Err("APPROVAL_WINDOW_INVALID".to_string());
    }
    let mut owner_process_id = 0;
    if unsafe { GetWindowThreadProcessId(owner, &mut owner_process_id) } == 0
        || owner_process_id != unsafe { GetCurrentProcessId() }
    {
        return Err("APPROVAL_WINDOW_INVALID".to_string());
    }
    if unsafe { GetForegroundWindow() } != owner {
        let _ = unsafe { SetForegroundWindow(owner) };
    }
    if unsafe { GetForegroundWindow() } != owner {
        return Err("APPROVAL_FOREGROUND_UNAVAILABLE".to_string());
    }

    let message = native_approval_prompt_text(binding);
    let caption = "InternalBeyond · Explicit Production Restore Approval";
    let message_wide: Vec<u16> = OsStr::new(&message).encode_wide().chain(Some(0)).collect();
    let caption_wide: Vec<u16> = OsStr::new(caption).encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MessageBoxW(
            owner,
            message_wide.as_ptr(),
            caption_wide.as_ptr(),
            0x0000_0004 | 0x0000_0030 | 0x0000_0100 | 0x0001_0000,
        )
    };
    match result {
        6 => Ok(()),
        7 => Err("APPROVAL_NATIVE_CONFIRMATION_REJECTED".to_string()),
        2 => Err("APPROVAL_NATIVE_CONFIRMATION_CANCELLED".to_string()),
        0 => Err("APPROVAL_NATIVE_CONFIRMATION_UNAVAILABLE".to_string()),
        _ => Err("APPROVAL_NATIVE_CONFIRMATION_FAILED".to_string()),
    }
}

#[cfg(not(windows))]
fn confirm_native_restore_approval(
    _owner: *mut std::ffi::c_void,
    _binding: &RecoveryApprovalBinding,
) -> Result<(), String> {
    Err("APPROVAL_NATIVE_CONFIRMATION_UNAVAILABLE".to_string())
}

fn validate_recovery_approval_slot(binding: &RecoveryApprovalBinding) -> Result<(), String> {
    let mut canonical_binding = binding.clone();
    canonicalize_recovery_binding_domains(&mut canonical_binding)?;
    let now = current_unix_ms();
    let active = recovery_apply_window_registry()
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    if active
        .as_ref()
        .map(|window| window.expires_at > now)
        .unwrap_or(false)
    {
        return Err("APPROVAL_WINDOW_ALREADY_OPEN".to_string());
    }
    drop(active);

    let mut issued = issued_recovery_approval_registry()
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    issued.retain(|_, record| record.expires_at > now);
    if issued
        .values()
        .any(|record| record.binding == canonical_binding)
    {
        return Err("APPROVAL_DUPLICATE_ISSUANCE".to_string());
    }
    Ok(())
}

fn issue_recovery_approval_inner(
    mut request: RecoveryApprovalIssueRequest,
    host: &RecoveryOnlyHostState,
    data_root: &Path,
) -> Result<ExplicitRestoreApproval, String> {
    canonicalize_recovery_binding_domains(&mut request.plan)?;
    validate_recovery_approval_issue_request(&request, host, data_root)?;
    validate_recovery_approval_slot(&request.plan)?;
    let now = current_unix_ms();
    {
        let active = recovery_apply_window_registry()
            .lock()
            .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
        if active
            .as_ref()
            .map(|window| window.expires_at > now)
            .unwrap_or(false)
        {
            return Err("APPROVAL_WINDOW_ALREADY_OPEN".to_string());
        }
    }
    let mut issued = issued_recovery_approval_registry()
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    issued.retain(|_, record| record.expires_at > now);
    if issued.values().any(|record| record.binding == request.plan) {
        return Err("APPROVAL_DUPLICATE_ISSUANCE".to_string());
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let lifecycle_id = uuid::Uuid::new_v4().simple().to_string();
    let expires_at = now.saturating_add(600_000);
    let binding = request.plan;
    let approval = ExplicitRestoreApproval {
        kind: RECOVERY_APPROVAL_KIND.to_string(),
        confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
        token: token.clone(),
        lifecycle_id: lifecycle_id.clone(),
        plan_id: binding.plan_id.clone(),
        plan_hash: binding.plan_hash.clone(),
        frozen_plan_id: binding.frozen_plan_id.clone(),
        frozen_plan_hash: binding.frozen_plan_hash.clone(),
        frozen_artifact_sha256: binding.frozen_artifact_sha256.clone(),
        transaction_id: binding.transaction_id.clone(),
        source_sha256: binding.source_sha256.clone(),
        source_size: binding.source_size,
        export_version: binding.export_version,
        supplemental_role_source_sha256: binding.supplemental_role_source_sha256.clone(),
        supplemental_memory_source_sha256: binding.supplemental_memory_source_sha256.clone(),
        authority_type: binding.authority_type.clone(),
        authority_status: binding.authority_status.clone(),
        authority_revision_id: binding.authority_revision_id.clone(),
        authority_revision_sha256: binding.authority_revision_sha256.clone(),
        provenance_digest: binding.provenance_digest.clone(),
        provenance_record_count: binding.provenance_record_count,
        target_snapshot_sha256: binding.target_snapshot_sha256.clone(),
        execution_phase: binding.execution_phase.clone(),
        target_origin: binding.target_origin.clone(),
        target_identity: binding.target_identity.clone(),
        database_name: binding.database_name.clone(),
        schema_version: binding.schema_version,
        selected_domains: binding.selected_domains.clone(),
        expires_at,
    };
    issued.insert(
        token,
        IssuedRecoveryApproval {
            binding,
            expires_at,
            checkpoint_written: false,
            lifecycle_id,
        },
    );
    Ok(approval)
}

fn require_issued_recovery_approval(
    approval: &ExplicitRestoreApproval,
    binding: &RecoveryApprovalBinding,
    checkpoint_written: Option<bool>,
) -> Result<(), String> {
    validate_restore_approval(approval, binding)?;
    let now = current_unix_ms();
    let issued = issued_recovery_approval_registry()
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    let record = issued
        .get(&approval.token)
        .ok_or_else(|| "APPROVAL_TOKEN_NOT_ISSUED_HERE".to_string())?;
    if record.expires_at <= now {
        return Err("APPROVAL_TOKEN_EXPIRED".to_string());
    }
    if record.expires_at != approval.expires_at {
        return Err("APPROVAL_TOKEN_EXPIRY_BINDING_MISMATCH".to_string());
    }
    if record.lifecycle_id != approval.lifecycle_id {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_MISMATCH".to_string());
    }
    if let Some(reason) = issued_binding_mismatch_code(&record.binding, binding) {
        return Err(reason);
    }
    if let Some(expected) = checkpoint_written {
        if record.checkpoint_written != expected {
            return Err(if expected {
                "APPROVAL_CHECKPOINT_NOT_MARKED_WRITTEN".to_string()
            } else {
                "CHECKPOINT_STATE_TRANSITION_INVALID".to_string()
            });
        }
    }
    Ok(())
}

fn approval_binding_from_checkpoint(
    checkpoint: &RecoveryCheckpoint,
) -> Result<RecoveryApprovalBinding, String> {
    let selected_domains = canonical_recovery_domains(&checkpoint.selected_domains)
        .map_err(|_| "RECOVERY_CHECKPOINT_DOMAIN_SET_INVALID".to_string())?;
    Ok(RecoveryApprovalBinding {
        plan_id: checkpoint.plan_id.clone(),
        plan_hash: checkpoint.plan_hash.clone(),
        frozen_plan_id: checkpoint.frozen_plan_id.clone(),
        frozen_plan_hash: checkpoint.frozen_plan_hash.clone(),
        frozen_artifact_sha256: checkpoint.frozen_artifact_sha256.clone(),
        transaction_id: checkpoint.transaction_id.clone(),
        source_sha256: checkpoint.source_sha256.clone(),
        source_size: checkpoint.source_size,
        export_version: checkpoint.export_version,
        supplemental_role_source_sha256: checkpoint.supplemental_role_source_sha256.clone(),
        supplemental_memory_source_sha256: checkpoint.supplemental_memory_source_sha256.clone(),
        authority_type: checkpoint.authority_type.clone(),
        authority_status: checkpoint.authority_status.clone(),
        authority_revision_id: checkpoint.authority_revision_id.clone(),
        authority_revision_sha256: checkpoint.authority_revision_sha256.clone(),
        provenance_digest: checkpoint.provenance_digest.clone(),
        provenance_record_count: checkpoint.provenance_record_count,
        target_snapshot_sha256: checkpoint.target_snapshot_sha256.clone(),
        execution_phase: checkpoint.execution_phase.clone(),
        target_origin: checkpoint.target_origin.clone(),
        target_identity: checkpoint.target_identity.clone(),
        database_name: checkpoint.database_name.clone(),
        schema_version: checkpoint.schema_version,
        selected_domains,
    })
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn recovery_apply_window_registry() -> &'static Mutex<Option<ActiveRecoveryApplyWindow>> {
    ACTIVE_RECOVERY_APPLY_WINDOW.get_or_init(|| Mutex::new(None))
}

fn open_recovery_apply_window_inner(
    approval: ExplicitRestoreApproval,
    mut binding: RecoveryApprovalBinding,
    host: &RecoveryOnlyHostState,
    data_root: &Path,
) -> Result<serde_json::Value, String> {
    if PRODUCTION_RESTORE_ENABLED {
        return Err("SCOPED_RECOVERY_WINDOW_UNEXPECTED_STATIC_ENABLE".to_string());
    }
    canonicalize_recovery_binding_domains(&mut binding)?;
    validate_restore_approval(&approval, &binding)?;
    if let Some(reason) = recovery_approval_binding_invalid_reason(&binding) {
        return Err(reason.to_string());
    }
    if binding.target_identity != host.target_identity {
        return Err("APPROVAL_HOST_TARGET_IDENTITY_MISMATCH".to_string());
    }
    if binding.target_origin != host.target_origin {
        return Err("APPROVAL_HOST_TARGET_ORIGIN_MISMATCH".to_string());
    }
    let now = current_unix_ms();
    if approval.expires_at <= now || approval.expires_at > now.saturating_add(600_000) {
        return Err("EXPLICIT_RESTORE_APPROVAL_EXPIRED_OR_TOO_LONG".to_string());
    }
    if verified_marker_path(data_root).exists() || consumed_marker_path(data_root).exists() {
        return Err("UNRESOLVED_RECOVERY_STATE_PRESENT".to_string());
    }
    let checkpoint_bytes = fs::read(checkpoint_path(data_root))
        .map_err(|_| "RECOVERY_ROLLBACK_CHECKPOINT_REQUIRED".to_string())?;
    let checkpoint: RecoveryCheckpoint = serde_json::from_slice(&checkpoint_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    if approval_binding_from_checkpoint(&checkpoint)? != binding {
        return Err("RECOVERY_CHECKPOINT_PLAN_BINDING_MISMATCH".to_string());
    }
    let lifecycle =
        validate_checkpoint_lifecycle_files(data_root, &checkpoint, &checkpoint_bytes, true)?;
    if lifecycle.lifecycle_id != approval.lifecycle_id
        || checkpoint.lifecycle_id != approval.lifecycle_id
    {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_MISMATCH".to_string());
    }
    require_issued_recovery_approval(&approval, &binding, Some(true))?;

    let registry = recovery_apply_window_registry();
    let mut active = registry
        .lock()
        .map_err(|_| "RECOVERY_APPLY_WINDOW_UNAVAILABLE".to_string())?;
    if active
        .as_ref()
        .map(|window| window.expires_at > now)
        .unwrap_or(false)
    {
        return Err("RECOVERY_APPLY_WINDOW_ALREADY_OPEN".to_string());
    }
    *active = None;
    consume_restore_approval_token(&approval.token, &binding)?;
    *active = Some(ActiveRecoveryApplyWindow {
        binding,
        token: approval.token,
        expires_at: approval.expires_at,
    });
    Ok(
        serde_json::json!({"ok":true,"planId":active.as_ref().unwrap().binding.plan_id,"expiresAt":approval.expires_at}),
    )
}

fn recovery_apply_window_matches(
    plan_id: &str,
    token: Option<&str>,
    binding: Option<&RecoveryApprovalBinding>,
) -> bool {
    let now = current_unix_ms();
    let registry = recovery_apply_window_registry();
    let Ok(mut active) = registry.lock() else {
        return false;
    };
    if active
        .as_ref()
        .map(|window| window.expires_at <= now)
        .unwrap_or(false)
    {
        *active = None;
    }
    let Some(window) = active.as_ref() else {
        return false;
    };
    let binding_matches = binding
        .map(|value| {
            let mut actual = window.binding.clone();
            let mut expected = value.clone();
            canonicalize_recovery_binding_domains(&mut actual).is_ok()
                && canonicalize_recovery_binding_domains(&mut expected).is_ok()
                && actual == expected
        })
        .unwrap_or(true);
    if window.binding.plan_id != plan_id
        || token.map(|v| v != window.token).unwrap_or(false)
        || !binding_matches
    {
        return false;
    }
    true
}

fn close_recovery_apply_window_inner(
    request: RecoveryApplyWindowCloseRequest,
    host: &RecoveryOnlyHostState,
) -> Result<serde_json::Value, String> {
    let registry = recovery_apply_window_registry();
    let mut active = registry
        .lock()
        .map_err(|_| "RECOVERY_APPLY_WINDOW_UNAVAILABLE".to_string())?;
    let Some(window) = active.as_ref() else {
        return Ok(serde_json::json!({"ok":true,"alreadyClosed":true}));
    };
    if window.binding.plan_id != request.plan_id || window.token != request.token {
        return Err("RECOVERY_APPLY_WINDOW_CLOSE_BINDING_INVALID".to_string());
    }
    if window.binding.target_identity != host.target_identity
        || window.binding.target_origin != host.target_origin
    {
        return Err("RECOVERY_APPLY_WINDOW_CLOSE_TARGET_MISMATCH".to_string());
    }
    *active = None;
    Ok(serde_json::json!({"ok":true,"closed":true,"planId":request.plan_id}))
}

fn write_recovery_checkpoint_inner(
    checkpoint: RecoveryCheckpoint,
    approval: ExplicitRestoreApproval,
    host: &RecoveryOnlyHostState,
    data_root: &Path,
) -> Result<serde_json::Value, String> {
    if PRODUCTION_RESTORE_ENABLED {
        return Err("SCOPED_RECOVERY_CHECKPOINT_UNEXPECTED_STATIC_ENABLE".to_string());
    }
    let binding = approval_binding_from_checkpoint(&checkpoint)?;
    validate_recovery_checkpoint(&checkpoint)?;
    require_issued_recovery_approval(&approval, &binding, Some(false))?;
    if checkpoint.lifecycle_id != approval.lifecycle_id {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_MISMATCH".to_string());
    }
    if checkpoint.target_identity != host.target_identity
        || checkpoint.target_origin != host.target_origin
    {
        return Err("RECOVERY_CHECKPOINT_TARGET_MISMATCH".to_string());
    }
    persist_checkpoint_lifecycle_artifacts_with(
        data_root,
        &checkpoint,
        &approval,
        &binding,
        |path, value| write_new_json(path, value),
    )?;
    finalize_checkpoint_lifecycle_for_approval(&approval, &binding, data_root)?;
    Ok(serde_json::json!({
        "ok": true,
        "planId": checkpoint.plan_id,
        "checkpointSha256": checkpoint.integrity_sha256,
        "lifecycleId": checkpoint.lifecycle_id,
        "firstBootPending": true
    }))
}

fn abort_recovery_checkpoint_before_apply_inner(
    approval: ExplicitRestoreApproval,
    binding: RecoveryApprovalBinding,
    host: &RecoveryOnlyHostState,
    data_root: &Path,
) -> Result<serde_json::Value, String> {
    if PRODUCTION_RESTORE_ENABLED {
        return Err("CHECKPOINT_ABORT_STATIC_RESTORE_ENABLE_INVALID".to_string());
    }
    validate_restore_approval(&approval, &binding)?;
    if let Some(reason) = recovery_approval_binding_invalid_reason(&binding) {
        return Err(reason.to_string());
    }
    if binding.target_identity != host.target_identity {
        return Err("APPROVAL_HOST_TARGET_IDENTITY_MISMATCH".to_string());
    }
    if binding.target_origin != host.target_origin {
        return Err("APPROVAL_HOST_TARGET_ORIGIN_MISMATCH".to_string());
    }
    if recovery_apply_window_matches(&binding.plan_id, None, Some(&binding)) {
        return Err("CHECKPOINT_ABORT_APPLY_WINDOW_OPEN".to_string());
    }

    let checkpoint_bytes = fs::read(checkpoint_path(data_root))
        .map_err(|_| "RECOVERY_CHECKPOINT_NOT_DURABLE".to_string())?;
    let checkpoint: RecoveryCheckpoint = serde_json::from_slice(&checkpoint_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    if approval_binding_from_checkpoint(&checkpoint)? != binding
        || checkpoint.lifecycle_id != approval.lifecycle_id
    {
        return Err("RECOVERY_CHECKPOINT_LIFECYCLE_BINDING_MISMATCH".to_string());
    }
    validate_checkpoint_lifecycle_files(data_root, &checkpoint, &checkpoint_bytes, true)?;
    require_issued_recovery_approval(&approval, &binding, Some(true))?;

    // Permanently cancel this process-local approval before touching its files.
    // If cleanup fails, apply remains impossible and the owned lifecycle journal
    // remains as a fail-closed recovery state.
    consume_restore_approval_token(&approval.token, &binding)?;
    cleanup_owned_recovery_checkpoint_lifecycle(data_root, &approval.lifecycle_id, &binding)
        .map_err(|_| "CHECKPOINT_LIFECYCLE_ABORT_CLEANUP_FAILED".to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "aborted": true,
        "planId": binding.plan_id,
        "lifecycleId": approval.lifecycle_id
    }))
}

fn recovery_data_root() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "RECOVERY_DATA_ROOT_UNAVAILABLE".to_string())?;
    Ok(PathBuf::from(local).join("InternalBeyond"))
}

fn write_new_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "RECOVERY_STATE_PATH_INVALID".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "RECOVERY_STATE_DIRECTORY_UNAVAILABLE".to_string())?;
    let bytes =
        serde_json::to_vec(value).map_err(|_| "RECOVERY_STATE_SERIALIZE_FAILED".to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("RECOVERY_STATE_TOO_LARGE".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "RECOVERY_STATE_ALREADY_EXISTS_OR_UNWRITABLE".to_string())?;
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("RECOVERY_STATE_WRITE_FAILED".to_string());
    }
    Ok(())
}

fn recovery_checkpoint_lifecycle_hash(
    lifecycle: &RecoveryCheckpointLifecycle,
) -> Result<String, String> {
    let mut unsigned = lifecycle.clone();
    unsigned.record_sha256.clear();
    let bytes = serde_json::to_vec(&unsigned)
        .map_err(|_| "CHECKPOINT_LIFECYCLE_SERIALIZE_FAILED".to_string())?;
    Ok(sha256_hex(&bytes))
}

fn make_recovery_checkpoint_lifecycle(
    checkpoint: &RecoveryCheckpoint,
    lifecycle_id: &str,
    phase: &str,
) -> Result<RecoveryCheckpointLifecycle, String> {
    if lifecycle_id.len() != 32 || !lifecycle_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("CHECKPOINT_LIFECYCLE_ID_INVALID".to_string());
    }
    let checkpoint_bytes = serde_json::to_vec(checkpoint)
        .map_err(|_| "RECOVERY_CHECKPOINT_SERIALIZE_FAILED".to_string())?;
    let mut lifecycle = RecoveryCheckpointLifecycle {
        schema: RECOVERY_CHECKPOINT_LIFECYCLE_SCHEMA.to_string(),
        version: 1,
        phase: phase.to_string(),
        lifecycle_id: lifecycle_id.to_string(),
        binding: approval_binding_from_checkpoint(checkpoint)?,
        checkpoint_integrity_sha256: checkpoint.integrity_sha256.clone(),
        checkpoint_file_sha256: sha256_hex(&checkpoint_bytes),
        created_at: checkpoint.created_at.clone(),
        record_sha256: String::new(),
    };
    lifecycle.record_sha256 = recovery_checkpoint_lifecycle_hash(&lifecycle)?;
    Ok(lifecycle)
}

fn validate_recovery_checkpoint_lifecycle_record(
    lifecycle: &RecoveryCheckpointLifecycle,
    expected_phase: &str,
) -> Result<(), String> {
    if lifecycle.schema != RECOVERY_CHECKPOINT_LIFECYCLE_SCHEMA
        || lifecycle.version != 1
        || lifecycle.phase != expected_phase
        || lifecycle.lifecycle_id.len() != 32
        || !lifecycle
            .lifecycle_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !is_sha256(&lifecycle.checkpoint_integrity_sha256)
        || !is_sha256(&lifecycle.checkpoint_file_sha256)
        || !is_sha256(&lifecycle.record_sha256)
        || lifecycle.created_at.is_empty()
        || lifecycle.created_at.len() > 64
        || recovery_approval_binding_invalid_reason(&lifecycle.binding).is_some()
    {
        return Err("RECOVERY_CHECKPOINT_LIFECYCLE_INVALID".to_string());
    }
    if recovery_checkpoint_lifecycle_hash(lifecycle)? != lifecycle.record_sha256 {
        return Err("RECOVERY_CHECKPOINT_LIFECYCLE_INTEGRITY_INVALID".to_string());
    }
    Ok(())
}

fn lifecycle_records_same_artifact(
    left: &RecoveryCheckpointLifecycle,
    right: &RecoveryCheckpointLifecycle,
) -> bool {
    let mut left_binding = left.binding.clone();
    let mut right_binding = right.binding.clone();
    left.schema == right.schema
        && left.version == right.version
        && left.lifecycle_id == right.lifecycle_id
        && canonicalize_recovery_binding_domains(&mut left_binding).is_ok()
        && canonicalize_recovery_binding_domains(&mut right_binding).is_ok()
        && left_binding == right_binding
        && left.checkpoint_integrity_sha256 == right.checkpoint_integrity_sha256
        && left.checkpoint_file_sha256 == right.checkpoint_file_sha256
        && left.created_at == right.created_at
}

fn validate_checkpoint_lifecycle_files(
    data_root: &Path,
    checkpoint: &RecoveryCheckpoint,
    checkpoint_bytes: &[u8],
    require_ready: bool,
) -> Result<RecoveryCheckpointLifecycle, String> {
    let intent_bytes = fs::read(checkpoint_lifecycle_intent_path(data_root))
        .map_err(|_| "RECOVERY_CHECKPOINT_LIFECYCLE_MISSING".to_string())?;
    let intent: RecoveryCheckpointLifecycle = serde_json::from_slice(&intent_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_LIFECYCLE_INVALID".to_string())?;
    validate_recovery_checkpoint_lifecycle_record(&intent, "RESERVED")?;
    let actual_file_hash = sha256_hex(checkpoint_bytes);
    let checkpoint_binding = approval_binding_from_checkpoint(checkpoint)?;
    if intent.lifecycle_id != checkpoint.lifecycle_id
        || !recovery_bindings_canonically_equal(&intent.binding, &checkpoint_binding)
        || intent.checkpoint_integrity_sha256 != checkpoint.integrity_sha256
        || intent.checkpoint_file_sha256 != actual_file_hash
        || intent.created_at != checkpoint.created_at
    {
        return Err("RECOVERY_CHECKPOINT_LIFECYCLE_BINDING_MISMATCH".to_string());
    }
    if !require_ready {
        return Ok(intent);
    }
    let ready_bytes = fs::read(checkpoint_lifecycle_ready_path(data_root))
        .map_err(|_| "RECOVERY_CHECKPOINT_LIFECYCLE_NOT_READY".to_string())?;
    let ready: RecoveryCheckpointLifecycle = serde_json::from_slice(&ready_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_LIFECYCLE_READY_INVALID".to_string())?;
    validate_recovery_checkpoint_lifecycle_record(&ready, "READY")?;
    if !lifecycle_records_same_artifact(&intent, &ready) {
        return Err("RECOVERY_CHECKPOINT_LIFECYCLE_BINDING_MISMATCH".to_string());
    }
    Ok(ready)
}

fn cleanup_owned_recovery_checkpoint_lifecycle(
    data_root: &Path,
    lifecycle_id: &str,
    binding: &RecoveryApprovalBinding,
) -> Result<(), String> {
    let intent_path = checkpoint_lifecycle_intent_path(data_root);
    let ready_path = checkpoint_lifecycle_ready_path(data_root);
    let artifact_path = checkpoint_path(data_root);
    let intent_bytes = fs::read(&intent_path)
        .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_OWNER_MISSING".to_string())?;
    let intent: RecoveryCheckpointLifecycle = serde_json::from_slice(&intent_bytes)
        .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_OWNER_INVALID".to_string())?;
    validate_recovery_checkpoint_lifecycle_record(&intent, "RESERVED")?;
    if intent.lifecycle_id != lifecycle_id
        || !recovery_bindings_canonically_equal(&intent.binding, binding)
    {
        return Err("CHECKPOINT_ARTIFACT_NOT_OWNED_BY_APPROVAL".to_string());
    }

    let ready = if ready_path.exists() {
        let ready_bytes = fs::read(&ready_path)
            .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_READY_READ_FAILED".to_string())?;
        let ready: RecoveryCheckpointLifecycle = serde_json::from_slice(&ready_bytes)
            .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_READY_INVALID".to_string())?;
        validate_recovery_checkpoint_lifecycle_record(&ready, "READY")?;
        if !lifecycle_records_same_artifact(&intent, &ready) {
            return Err("CHECKPOINT_ARTIFACT_NOT_OWNED_BY_APPROVAL".to_string());
        }
        true
    } else {
        false
    };

    let checkpoint_exists = artifact_path.exists();
    if checkpoint_exists {
        let checkpoint_bytes = fs::read(&artifact_path)
            .map_err(|_| "CHECKPOINT_ARTIFACT_OWNERSHIP_UNVERIFIABLE".to_string())?;
        if sha256_hex(&checkpoint_bytes) != intent.checkpoint_file_sha256 {
            return Err("CHECKPOINT_ARTIFACT_NOT_OWNED_BY_APPROVAL".to_string());
        }
        let checkpoint: RecoveryCheckpoint = serde_json::from_slice(&checkpoint_bytes)
            .map_err(|_| "CHECKPOINT_ARTIFACT_OWNERSHIP_UNVERIFIABLE".to_string())?;
        if checkpoint.lifecycle_id != lifecycle_id
            || approval_binding_from_checkpoint(&checkpoint)? != *binding
            || checkpoint.integrity_sha256 != intent.checkpoint_integrity_sha256
        {
            return Err("CHECKPOINT_ARTIFACT_NOT_OWNED_BY_APPROVAL".to_string());
        }
    }

    if recovery_apply_window_matches(&binding.plan_id, None, Some(binding)) {
        return Err("CHECKPOINT_CLEANUP_APPLY_WINDOW_OPEN".to_string());
    }
    if ready {
        fs::remove_file(&ready_path)
            .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_FAILED".to_string())?;
    }
    if checkpoint_exists {
        fs::remove_file(&artifact_path)
            .map_err(|_| "CHECKPOINT_ARTIFACT_CLEANUP_FAILED".to_string())?;
    }
    fs::remove_file(&intent_path).map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_FAILED".to_string())?;
    Ok(())
}

fn persist_checkpoint_lifecycle_artifacts_with<F>(
    data_root: &Path,
    checkpoint: &RecoveryCheckpoint,
    approval: &ExplicitRestoreApproval,
    binding: &RecoveryApprovalBinding,
    write_checkpoint: F,
) -> Result<RecoveryCheckpointLifecycle, String>
where
    F: FnOnce(&Path, &RecoveryCheckpoint) -> Result<(), String>,
{
    let checkpoint_binding = approval_binding_from_checkpoint(checkpoint)?;
    if checkpoint.lifecycle_id != approval.lifecycle_id
        || !recovery_bindings_canonically_equal(&checkpoint_binding, binding)
    {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_MISMATCH".to_string());
    }
    if checkpoint_path(data_root).exists()
        || checkpoint_lifecycle_intent_path(data_root).exists()
        || checkpoint_lifecycle_ready_path(data_root).exists()
        || verified_marker_path(data_root).exists()
        || consumed_marker_path(data_root).exists()
    {
        return Err("UNRESOLVED_RECOVERY_STATE_PRESENT".to_string());
    }

    let intent =
        make_recovery_checkpoint_lifecycle(checkpoint, &approval.lifecycle_id, "RESERVED")?;
    write_new_json(&checkpoint_lifecycle_intent_path(data_root), &intent)
        .map_err(|_| "CHECKPOINT_LIFECYCLE_INTENT_WRITE_FAILED".to_string())?;

    if let Err(write_error) = write_checkpoint(&checkpoint_path(data_root), checkpoint) {
        if !checkpoint_path(data_root).exists() {
            cleanup_owned_recovery_checkpoint_lifecycle(data_root, &approval.lifecycle_id, binding)
                .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_FAILED".to_string())?;
            return Err(write_error);
        }
        return Err("CHECKPOINT_WRITE_CONFLICT_LIFECYCLE_PENDING".to_string());
    }

    let checkpoint_bytes = match fs::read(checkpoint_path(data_root)) {
        Ok(bytes) => bytes,
        Err(_) => {
            let cleaned = cleanup_owned_recovery_checkpoint_lifecycle(
                data_root,
                &approval.lifecycle_id,
                binding,
            )
            .is_ok();
            return Err(if cleaned {
                "CHECKPOINT_DURABLE_READBACK_FAILED"
            } else {
                "CHECKPOINT_DURABLE_READBACK_FAILED_LIFECYCLE_PENDING"
            }
            .to_string());
        }
    };
    let persisted: RecoveryCheckpoint = match serde_json::from_slice(&checkpoint_bytes) {
        Ok(value) => value,
        Err(_) => {
            let cleaned = cleanup_owned_recovery_checkpoint_lifecycle(
                data_root,
                &approval.lifecycle_id,
                binding,
            )
            .is_ok();
            return Err(if cleaned {
                "CHECKPOINT_DURABLE_VERIFY_FAILED"
            } else {
                "CHECKPOINT_DURABLE_VERIFY_FAILED_LIFECYCLE_PENDING"
            }
            .to_string());
        }
    };
    if validate_recovery_checkpoint(&persisted).is_err()
        || sha256_hex(&checkpoint_bytes) != intent.checkpoint_file_sha256
        || approval_binding_from_checkpoint(&persisted)? != *binding
        || persisted.lifecycle_id != approval.lifecycle_id
    {
        let cleaned =
            cleanup_owned_recovery_checkpoint_lifecycle(data_root, &approval.lifecycle_id, binding)
                .is_ok();
        return Err(if cleaned {
            "CHECKPOINT_DURABLE_VERIFY_FAILED"
        } else {
            "CHECKPOINT_DURABLE_VERIFY_FAILED_LIFECYCLE_PENDING"
        }
        .to_string());
    }

    let mut ready = intent.clone();
    ready.phase = "READY".to_string();
    ready.record_sha256 = recovery_checkpoint_lifecycle_hash(&ready)?;
    if write_new_json(&checkpoint_lifecycle_ready_path(data_root), &ready).is_err() {
        let cleaned =
            cleanup_owned_recovery_checkpoint_lifecycle(data_root, &approval.lifecycle_id, binding)
                .is_ok();
        return Err(if cleaned {
            "CHECKPOINT_LIFECYCLE_READY_MARKER_WRITE_FAILED"
        } else {
            "CHECKPOINT_LIFECYCLE_READY_MARKER_WRITE_FAILED_LIFECYCLE_PENDING"
        }
        .to_string());
    }
    let checkpoint_bytes = fs::read(checkpoint_path(data_root))
        .map_err(|_| "CHECKPOINT_DURABLE_READBACK_FAILED_LIFECYCLE_PENDING".to_string())?;
    let verified_lifecycle =
        validate_checkpoint_lifecycle_files(data_root, checkpoint, &checkpoint_bytes, true)
            .map_err(|_| "CHECKPOINT_LIFECYCLE_READY_VERIFY_FAILED".to_string())?;
    if verified_lifecycle.lifecycle_id != approval.lifecycle_id {
        return Err("CHECKPOINT_LIFECYCLE_BINDING_MISMATCH".to_string());
    }
    Ok(ready)
}

fn mark_issued_checkpoint_written(
    approval: &ExplicitRestoreApproval,
    binding: &RecoveryApprovalBinding,
    data_root: &Path,
) -> Result<(), String> {
    let checkpoint_bytes = fs::read(checkpoint_path(data_root))
        .map_err(|_| "RECOVERY_CHECKPOINT_NOT_DURABLE".to_string())?;
    let checkpoint: RecoveryCheckpoint = serde_json::from_slice(&checkpoint_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    validate_checkpoint_lifecycle_files(data_root, &checkpoint, &checkpoint_bytes, true)?;
    if checkpoint.lifecycle_id != approval.lifecycle_id
        || approval_binding_from_checkpoint(&checkpoint)? != *binding
    {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_MISMATCH".to_string());
    }

    let mut issued = issued_recovery_approval_registry()
        .lock()
        .map_err(|_| "APPROVAL_TOKEN_STATE_INVALID".to_string())?;
    let record = issued
        .get_mut(&approval.token)
        .ok_or_else(|| "APPROVAL_TOKEN_NOT_ISSUED_HERE".to_string())?;
    if record.expires_at <= current_unix_ms() {
        return Err("APPROVAL_TOKEN_EXPIRED".to_string());
    }
    if record.expires_at != approval.expires_at {
        return Err("APPROVAL_TOKEN_EXPIRY_BINDING_MISMATCH".to_string());
    }
    if record.lifecycle_id != approval.lifecycle_id {
        return Err("APPROVAL_CHECKPOINT_LIFECYCLE_ID_MISMATCH".to_string());
    }
    if let Some(reason) = issued_binding_mismatch_code(&record.binding, binding) {
        return Err(reason);
    }
    if record.checkpoint_written {
        return Err("CHECKPOINT_STATE_TRANSITION_INVALID".to_string());
    }
    record.checkpoint_written = true;
    Ok(())
}

fn finalize_checkpoint_lifecycle_for_approval(
    approval: &ExplicitRestoreApproval,
    binding: &RecoveryApprovalBinding,
    data_root: &Path,
) -> Result<(), String> {
    match mark_issued_checkpoint_written(approval, binding, data_root) {
        Ok(()) => Ok(()),
        Err(reason) => {
            cleanup_owned_recovery_checkpoint_lifecycle(data_root, &approval.lifecycle_id, binding)
                .map_err(|_| "CHECKPOINT_LIFECYCLE_CLEANUP_FAILED".to_string())?;
            Err(reason)
        }
    }
}

fn recovery_boot_policy_from_dir(data_root: &Path) -> RecoveryBootPolicy {
    let checkpoint_path = data_root.join("recovery-checkpoint.json");
    let lifecycle_intent_path = checkpoint_lifecycle_intent_path(data_root);
    let lifecycle_ready_path = checkpoint_lifecycle_ready_path(data_root);
    let consumed_path = data_root.join("recovery-first-boot-consumed.json");
    if !checkpoint_path.exists() {
        return if consumed_path.exists()
            || verified_marker_path(data_root).exists()
            || lifecycle_intent_path.exists()
            || lifecycle_ready_path.exists()
        {
            /* A well-formed finalize marker retires the lifecycle once the
               checkpoint artifact has been cleared; otherwise fail closed. */
            if finalized_marker_well_formed(data_root) {
                RecoveryBootPolicy {
                    mode: RecoveryBootMode::Normal,
                    plan_id: None,
                }
            } else {
                RecoveryBootPolicy {
                    mode: RecoveryBootMode::Blocked,
                    plan_id: None,
                }
            }
        } else {
            RecoveryBootPolicy::normal()
        };
    }
    let checkpoint_bytes = match fs::read(&checkpoint_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            return RecoveryBootPolicy {
                mode: RecoveryBootMode::Blocked,
                plan_id: None,
            }
        }
    };
    let checkpoint: RecoveryCheckpoint = match serde_json::from_slice(&checkpoint_bytes) {
        Ok(value) => value,
        Err(_) => {
            return RecoveryBootPolicy {
                mode: RecoveryBootMode::Blocked,
                plan_id: None,
            }
        }
    };
    if validate_recovery_checkpoint(&checkpoint).is_err() {
        return RecoveryBootPolicy {
            mode: RecoveryBootMode::Blocked,
            plan_id: None,
        };
    }
    if validate_checkpoint_lifecycle_files(data_root, &checkpoint, &checkpoint_bytes, true).is_err()
    {
        return RecoveryBootPolicy {
            mode: RecoveryBootMode::Blocked,
            plan_id: Some(checkpoint.plan_id),
        };
    }
    let verified: RecoveryCheckpointVerifiedMarker = match fs::read(verified_marker_path(data_root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(value) => value,
        None => {
            return RecoveryBootPolicy {
                mode: RecoveryBootMode::Blocked,
                plan_id: Some(checkpoint.plan_id),
            }
        }
    };
    if verified.schema != "internalbeyond.recovery-checkpoint-verified"
        || verified.version != 1
        || verified.plan_id != checkpoint.plan_id
        || verified.verified_at.is_empty()
    {
        return RecoveryBootPolicy {
            mode: RecoveryBootMode::Blocked,
            plan_id: Some(checkpoint.plan_id),
        };
    }
    /* Recovery Finalize Authority: a valid, plan-pinned finalize marker moves
       the boot policy to Normal without deleting the checkpoint artifact. */
    let checkpoint_file_sha256 = sha256_hex(&checkpoint_bytes);
    if read_finalized_marker_valid_for(
        data_root,
        &checkpoint.plan_id,
        &checkpoint.lifecycle_id,
        &checkpoint_file_sha256,
    )
    .is_some()
    {
        return RecoveryBootPolicy {
            mode: RecoveryBootMode::Normal,
            plan_id: Some(checkpoint.plan_id),
        };
    }
    if !consumed_path.exists() {
        return RecoveryBootPolicy {
            mode: RecoveryBootMode::FirstBootPending,
            plan_id: Some(checkpoint.plan_id),
        };
    }
    let consumed: RecoveryFirstBootConsumed = match fs::read(&consumed_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(value) => value,
        None => {
            return RecoveryBootPolicy {
                mode: RecoveryBootMode::Blocked,
                plan_id: Some(checkpoint.plan_id),
            }
        }
    };
    if consumed.schema != RECOVERY_CONSUMED_SCHEMA
        || consumed.version != 1
        || consumed.plan_id != checkpoint.plan_id
        || consumed.consumed_at.is_empty()
    {
        return RecoveryBootPolicy {
            mode: RecoveryBootMode::Blocked,
            plan_id: Some(checkpoint.plan_id),
        };
    }
    RecoveryBootPolicy {
        mode: RecoveryBootMode::ActiveQuarantine,
        plan_id: Some(checkpoint.plan_id),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeMode {
    Production,
    Acceptance,
    Development,
}

impl RuntimeMode {
    fn parse(requested: Option<&str>, debug_build: bool) -> Result<Self, String> {
        let value = requested.map(str::trim).filter(|value| !value.is_empty());
        match value {
            None if debug_build => Ok(Self::Development),
            None => Ok(Self::Production),
            Some("production") => Ok(Self::Production),
            Some("acceptance") => Ok(Self::Acceptance),
            Some("development") if debug_build => Ok(Self::Development),
            Some("development") => {
                Err("RUNTIME_MODE_INVALID: development mode requires a debug build".to_string())
            }
            Some(other) => Err(format!(
                "RUNTIME_MODE_INVALID: unsupported runtime mode {other}"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Acceptance => "acceptance",
            Self::Development => "development",
        }
    }

    fn root_class(self) -> &'static str {
        match self {
            Self::Production => "canonical-inno",
            Self::Acceptance => "tauri-resource",
            Self::Development => "workspace",
        }
    }
}

#[derive(Clone, Debug)]
struct RuntimeResolution {
    root: PathBuf,
    mode: RuntimeMode,
    root_class: &'static str,
    product_version: String,
    payload_manifest_version: Option<u64>,
    payload_identity: Option<String>,
}

fn acceptance_run_id() -> Option<String> {
    let value = std::env::var("IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID").ok()?;
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some(value)
}

fn acceptance_transport_log(event: &str) {
    if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() != Some("1") {
        return;
    }
    let run_id = acceptance_run_id().unwrap_or_else(|| "missing".to_string());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("p32-w3a-{}-transport.log", run_id));
    let line = format!(
        "ts={} pid={} runId={} event={}\n",
        stamp,
        std::process::id(),
        run_id,
        event
    );
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn acceptance_url_class(scheme: &str, host: Option<&str>, path: &str) -> &'static str {
    if path.ends_with("InternalBeyond.html") {
        return "INTERNALBEYOND";
    }
    if scheme == "about" || (scheme.is_empty() && path == "/") {
        return "BLANK";
    }
    if scheme == "tauri" || scheme == "data" || scheme == "blob" {
        return "OPAQUE";
    }
    if (scheme == "http" || scheme == "https")
        && matches!(
            host,
            Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost")
        )
    {
        return "OTHER_LOCAL";
    }
    "UNEXPECTED"
}

fn acceptance_scheme_class(scheme: &str) -> &'static str {
    match scheme {
        "tauri" => "TAURI",
        "asset" => "ASSET",
        "http" => "HTTP",
        "https" => "HTTPS",
        "file" => "FILE",
        "about" => "ABOUT",
        "" => "EMPTY",
        _ => "CUSTOM",
    }
}

/* P32-W.3A: acceptance-only fixed DOM probe. It is never emitted unless the
explicitly test-owned IB_ACCEPTANCE_SECRET_ROUTES=1 environment gate is
present. The probe contains no interpolation except the numeric loopback
port, accepts no script input, and reports only bounded booleans/URL metadata
to the existing loopback static server's test-only endpoint. */
const ACCEPTANCE_BOOTSTRAP_PROBE: &str = r###"(function(){
  'use strict';
  if (window.__IB_W3C_BOOTSTRAP_PROBE_RUN_ID__ === '__RUN_ID__') return;
  window.__IB_W3C_BOOTSTRAP_PROBE_RUN_ID__ = '__RUN_ID__';
  var endpoint = 'http://127.0.0.1:__PORT__/__p32-w3a/acceptance';
  var startedAt = Date.now();
  var result = {
    schemaVersion: 1, runId: '__RUN_ID__', phase: 'probe_started', ready: false,
    tauri: false, navHome: false, readyState: '', origin: '', pathname: '',
    documentSeq: 0, urlClass: 'BOOTSTRAP', pageLoadPhase: 'initialization',
    elapsedMs: 0, done: false
  };
  function delay(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); }
  async function request(url, options, timeout){
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var requestOptions = Object.assign({}, options || {});
    if (controller) requestOptions.signal = controller.signal;
    var timer = setTimeout(function(){ if (controller) controller.abort(); }, timeout);
    try {
      if (controller) return await fetch(url, requestOptions);
      return await Promise.race([fetch(url, requestOptions), delay(timeout).then(function(){ return null; })]);
    } finally { clearTimeout(timer); }
  }
  async function report(){
    result.elapsedMs = Date.now() - startedAt;
    var payload = JSON.stringify(result);
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var response = await request(endpoint, {
          method: 'POST', mode: 'cors', credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' }, body: payload, cache: 'no-store'
        }, 900);
        if (response && response.ok) return true;
      } catch (e) { /* bounded delivery retry */ }
      await delay(120);
    }
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain' }))) return true;
    } catch (e) { /* bounded failure; the harness fails closed */ }
    return false;
  }
  async function run(){
    for (var attempt = 0; attempt < 20; attempt++) {
      try {
        var response = await request(endpoint, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' }, 700);
        if (response && response.ok) { await report(); return; }
      } catch (e) { /* bounded readiness retry */ }
      await delay(150);
    }
  }
  run().catch(function(){});
})();"###;

const ACCEPTANCE_DOCUMENT_PROBE: &str = r###"(function(){
  'use strict';
  var documentSeq = __DOCUMENT_SEQ__;
  var urlClass = '__URL_CLASS__';
  var guard = '__IB_W3C_DOCUMENT_PROBE_' + documentSeq + '__';
  if (window[guard]) return;
  window[guard] = true;
  var endpoint = 'http://127.0.0.1:__PORT__/__p32-w3a/acceptance';
  var startedAt = Date.now();
  var result = {
    schemaVersion: 1, runId: '__RUN_ID__', phase: 'document_state', ready: false,
    tauri: false, navHome: false, readyState: '', origin: '', pathname: '',
    documentSeq: documentSeq, urlClass: urlClass, pageLoadPhase: 'finished',
    hrefClass: '', originClass: '', pathnameClass: '', titlePresent: false,
    bodyPresent: false, ibMarkerPresent: false, ibHostPresent: false,
    elapsedMs: 0, done: false
  };
  function delay(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); }
  async function request(url, options, timeout){
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var requestOptions = Object.assign({}, options || {});
    if (controller) requestOptions.signal = controller.signal;
    var timer = setTimeout(function(){ if (controller) controller.abort(); }, timeout);
    try {
      if (controller) return await fetch(url, requestOptions);
      return await Promise.race([fetch(url, requestOptions), delay(timeout).then(function(){ return null; })]);
    } finally { clearTimeout(timer); }
  }
  async function endpointReady(){
    for (var attempt = 0; attempt < 20; attempt++) {
      try {
        var response = await request(endpoint, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' }, 700);
        if (response && response.ok) return true;
      } catch (e) { /* bounded readiness retry */ }
      await delay(150);
    }
    return false;
  }
  async function report(phase){
    result.phase = phase;
    result.elapsedMs = Date.now() - startedAt;
    var payload = JSON.stringify(result);
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var response = await request(endpoint, {
          method: 'POST', mode: 'cors', credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' }, body: payload, cache: 'no-store'
        }, 900);
        if (response && response.ok) return true;
      } catch (e) { /* bounded delivery retry */ }
      await delay(120);
    }
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain' }))) return true;
    } catch (e) { /* bounded failure; the harness fails closed */ }
    return false;
  }
  async function waitFor(fn, timeout){
    var end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (fn()) return true; } catch (e) {}
      await delay(120);
    }
    return false;
  }
  function hrefClass(){
    var protocol = String(location.protocol || '').toLowerCase();
    if (protocol === 'tauri:') return 'TAURI';
    if (protocol === 'asset:') return 'ASSET';
    if (protocol === 'http:') return 'HTTP';
    if (protocol === 'https:') return 'HTTPS';
    if (protocol === 'file:') return 'FILE';
    if (protocol === 'about:') return 'ABOUT';
    if (protocol === 'data:') return 'DATA';
    return protocol ? 'CUSTOM' : 'EMPTY';
  }
  function originClass(){
    var origin = String(location.origin || '');
    if (!origin || origin === 'null') return 'OPAQUE';
    if (/^https?:\/\/tauri\.localhost(?::\d+)?$/i.test(origin)) return 'TAURI_LOCAL';
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin)) return 'LOOPBACK';
    return 'OTHER';
  }
  function pathnameClass(){
    var pathname = String(location.pathname || '');
    if (/InternalBeyond\.html$/i.test(pathname)) return 'INTERNALBEYOND';
    if (pathname === '/' || pathname === '') return 'ROOT';
    return 'OTHER';
  }
  async function run(){
    if (!await endpointReady()) { result.errorCode = 'ENDPOINT_NOT_ARMED'; await report('probe_failed'); return; }
    result.ready = await waitFor(function(){ return document.readyState === 'complete'; }, 15000);
    result.readyState = String(document.readyState || '').slice(0, 16);
    result.origin = String(location.origin || '').slice(0, 160);
    result.pathname = String(location.pathname || '').slice(0, 160);
    result.hrefClass = hrefClass();
    result.originClass = originClass();
    result.pathnameClass = pathnameClass();
    result.titlePresent = typeof document.title === 'string' && document.title.length > 0;
    result.bodyPresent = !!document.body;
    result.ibMarkerPresent = window.__IB_TAURI_HOST__ === true;
    result.ibHostPresent = !!(window.IB && IB.host);
    if (!result.ready) { result.errorCode = 'DOCUMENT_TIMEOUT'; await report('probe_failed'); return; }
    await report('document_state');
    result.tauri = await waitFor(function(){
      return !!(window.IB && IB.host && typeof IB.host.platform === 'function' && IB.host.platform() === 'tauri');
    }, 15000);
    await report('tauri_recognized');
    result.navHome = await waitFor(function(){
      var nav = document.getElementById('nav-home');
      return !!(nav && nav.isConnected !== false);
    }, 15000);
    result.done = true;
    await report('nav_home_found');
  }
  run().catch(function(){ result.errorCode = 'UNEXPECTED_PROBE_ERROR'; report('probe_failed'); });
})();"###;

const ACCEPTANCE_FULL_SECRET_ROUTE_PROBE: &str = r###"(function(){
  'use strict';
  if (window.__IB_W3A_SECRET_PROBE_STARTED__) return;
  window.__IB_W3A_SECRET_PROBE_STARTED__ = true;
  try { document.title = 'P32-W3A acceptance probe'; } catch (e) {}
  var endpoint = 'http://127.0.0.1:__PORT__/__p32-w3a/acceptance';
  var startedAt = Date.now();
  var result = {
    schemaVersion: 1, runId: '__RUN_ID__', phase: 'probe_started', ready: false, tauri: false, navHome: false,
    initialConsoleHidden: false, sixClicksNoConsole: false, timeoutReset: false,
    consoleOpened: false, consoleInput: false, consoleFocus: false,
    maliciousRejected: false, beyondOpened: false, beyondClosed: false,
    consoleReopened: false, middlebrainOpened: false, noNormalPage: false,
    middlebrainClosed: false, hashReturned: false, noMiddlebrainQuery: false,
    directMessageSent: false, modelCallsObserved: 0, origin: '', pathname: '',
    documentSeq: __DOCUMENT_SEQ__, urlClass: '__URL_CLASS__', pageLoadPhase: 'finished',
    elapsedMs: 0, done: false
  };
  function delay(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); }
  function shown(node){ return !!(node && !node.hidden && node.classList && node.classList.contains('is-open')); }
  function consoleShown(){ return shown(document.getElementById('ib-secret-route-console')); }
  function waitFor(fn, timeout){
    var end = Date.now() + (timeout || 15000);
    return new Promise(function(resolve){
      (function tick(){
        var value = false;
        try { value = !!fn(); } catch (e) { value = false; }
        if (value) { resolve(true); return; }
        if (Date.now() >= end) { resolve(false); return; }
        setTimeout(tick, 120);
      })();
    });
  }
  function navClick(){
    var nav = document.getElementById('nav-home');
    if (!nav) return false;
    nav.click();
    return true;
  }
  async function clickSeries(count){
    for (var i = 0; i < count; i++) { navClick(); await delay(110); }
  }
  function submitAlias(value){
    var input = document.querySelector('.ib-secret-route-input');
    var form = document.querySelector('.ib-secret-route-form');
    if (!input || !form) return false;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  }
  async function report(){
    result.elapsedMs = Date.now() - startedAt;
    var payload = JSON.stringify(result);
    for (var attempt = 0; attempt < 5; attempt++) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeoutId = setTimeout(function(){ if (controller) controller.abort(); }, 900);
      try {
        var response = await fetch(endpoint, {
          method: 'POST', mode: 'cors', credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' }, body: payload, cache: 'no-store',
          signal: controller ? controller.signal : undefined
        });
        if (response && response.ok) { clearTimeout(timeoutId); return true; }
      } catch (e) { /* bounded retry; the harness fails closed if all fail */ }
      clearTimeout(timeoutId);
      await delay(120);
    }
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain' }))) return true;
    } catch (e) { /* bounded failure; the harness fails closed */ }
    return false;
  }
  async function reportPhase(phase){
    result.phase = phase;
    return report();
  }
  async function run(){
    result.phase = 'probe_started';
    result.ready = await waitFor(function(){
      return document.readyState === 'complete' &&
        !!document.getElementById('nav-home') &&
        !!(window.IB && IB.secretRoutes && IB.host);
    }, 15000);
    if (!result.ready) { result.phase = 'probe_failed'; result.errorCode = 'DOCUMENT_TIMEOUT'; await report(); return; }
    result.origin = String(location.origin || '').slice(0, 160);
    result.pathname = String(location.pathname || '').slice(0, 160);
    await reportPhase('document_state');
    result.tauri = !!(IB.host && typeof IB.host.platform === 'function' && IB.host.platform() === 'tauri');
    await reportPhase('tauri_recognized');
    result.navHome = !!document.getElementById('nav-home');
    await reportPhase('nav_home_found');
    result.initialConsoleHidden = !consoleShown();
    await clickSeries(6);
    result.sixClicksNoConsole = !consoleShown();
    await delay(2000);
    navClick();
    result.timeoutReset = !consoleShown();
    await delay(2000);
    await clickSeries(7);
    result.consoleOpened = await waitFor(consoleShown, 3000);
    var input = document.querySelector('.ib-secret-route-input');
    result.consoleInput = !!input;
    result.consoleFocus = !!(input && document.activeElement === input);
    result.maliciousRejected = submitAlias('https://example.com') && await waitFor(function(){
      var status = document.querySelector('.ib-secret-route-status');
      return consoleShown() && status && status.textContent === 'Unknown secret route.';
    }, 2000);
    submitAlias('Beyond');
    result.beyondOpened = await waitFor(function(){
      var terminal = document.getElementById('ibterm');
      return !!(terminal && terminal.classList.contains('ibterm-on'));
    }, 3000);
    var terminalInput = document.getElementById('ibterm-input');
    if (terminalInput) {
      terminalInput.value = 'exit';
      terminalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    result.beyondClosed = await waitFor(function(){
      var terminal = document.getElementById('ibterm');
      return !!terminal && !terminal.classList.contains('ibterm-on');
    }, 2000);
    if (location.hash !== '#chat') location.hash = 'chat';
    await waitFor(function(){ return location.hash === '#chat'; }, 2000);
    await clickSeries(7);
    result.consoleReopened = await waitFor(consoleShown, 3000);
    submitAlias('middlebrain');
    result.middlebrainOpened = await waitFor(function(){ return !!document.getElementById('ib-middle-brain-direct-root'); }, 4000);
    result.noNormalPage = !document.getElementById('page-middle-brain-direct');
    var close = document.querySelector('.ib-mbd-close');
    if (close) close.click();
    result.middlebrainClosed = await waitFor(function(){ return !document.getElementById('ib-middle-brain-direct-root'); }, 2000);
    result.hashReturned = location.hash === '#chat';
    result.noMiddlebrainQuery = String(location.search || '').indexOf('middlebrain') < 0;
    result.done = true;
    await reportPhase('probe_complete');
  }
  run().catch(function(error){
    result.phase = 'probe_failed';
    result.errorCode = 'UNEXPECTED_PROBE_ERROR';
    report();
  });
})();"###;

fn acceptance_probe_parameters() -> Option<(String, String)> {
    if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() != Some("1") {
        return None;
    }
    let port = std::env::var("IB_WEB_PORT").unwrap_or_else(|_| "23120".to_string());
    let run_id = match acceptance_run_id() {
        Some(value) => value,
        None => return None,
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((port, run_id))
}

fn acceptance_bootstrap_probe() -> Option<String> {
    if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES_MODE")
        .ok()
        .as_deref()
        != Some("transport")
    {
        return None;
    }
    let (port, run_id) = acceptance_probe_parameters()?;
    acceptance_transport_log("M0_GATE_DETECTED");
    let script = ACCEPTANCE_BOOTSTRAP_PROBE
        .replace("__PORT__", &port)
        .replace("__RUN_ID__", &run_id);
    acceptance_transport_log("M1_PROBE_REGISTERED");
    acceptance_transport_log(&format!("M1_PROBE_PORT_{}", port));
    acceptance_transport_log("M1_BOOTSTRAP_PROBE_REGISTERED");
    Some(script)
}

fn acceptance_document_probe(document_seq: u32, url_class: &str) -> Option<String> {
    if url_class != "INTERNALBEYOND" {
        return None;
    }
    let (port, run_id) = acceptance_probe_parameters()?;
    let source = match std::env::var("IB_ACCEPTANCE_SECRET_ROUTES_MODE")
        .ok()
        .as_deref()
    {
        Some("transport") => ACCEPTANCE_DOCUMENT_PROBE,
        _ => ACCEPTANCE_FULL_SECRET_ROUTE_PROBE,
    };
    Some(
        source
            .replace("__PORT__", &port)
            .replace("__RUN_ID__", &run_id)
            .replace("__DOCUMENT_SEQ__", &document_seq.to_string())
            .replace("__URL_CLASS__", url_class),
    )
}

fn acceptance_endpoint_ready() -> bool {
    let Some((port, _)) = acceptance_probe_parameters() else {
        return false;
    };
    let address = format!("127.0.0.1:{port}");
    let Ok(socket_address) = address.parse() else {
        return false;
    };
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&socket_address, Duration::from_millis(300))
    else {
        return false;
    };
    let request = format!(
        "GET /__p32-w3a/acceptance HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut response = [0_u8; 512];
    let Ok(size) = stream.read(&mut response) else {
        return false;
    };
    let response = String::from_utf8_lossy(&response[..size]);
    response.starts_with("HTTP/1.1 200") && response.contains("\"ok\":true")
}

fn wait_for_acceptance_endpoint() -> bool {
    for _ in 0..150 {
        if acceptance_endpoint_ready() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

/* The Web Core and local services remain the product authority. This small
host-owned record exists only to distinguish a runner started by this Tauri
process from a healthy runner that was already present. */
struct HostLifecycle {
    root: PathBuf,
    runtime: RuntimeResolution,
    boot_state: PathBuf,
    recovery_policy: RecoveryBootPolicy,
    recovery_first_boot_pending: AtomicBool,
    recovery_data_root: Option<PathBuf>,
    launcher_pid: AtomicU32,
    launcher_done: AtomicBool,
    runner_owned: AtomicBool,
    shutdown_requested: AtomicBool,
}

impl HostLifecycle {
    fn new(runtime: RuntimeResolution, recovery_policy: RecoveryBootPolicy) -> Self {
        let root = runtime.root.clone();
        let recovery_data_root = recovery_data_root().ok();
        let boot_state = if let Ok(dir) = std::env::var("IB_BOOT_STATE_DIR") {
            PathBuf::from(dir).join("boot-state.json")
        } else if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            PathBuf::from(local_app_data)
                .join("InternalBeyond")
                .join("boot-state.json")
        } else {
            root.join("logs").join("boot-state.json")
        };
        Self {
            root,
            runtime,
            boot_state,
            recovery_first_boot_pending: AtomicBool::new(recovery_policy.first_boot_pending()),
            recovery_data_root,
            recovery_policy,
            launcher_pid: AtomicU32::new(0),
            launcher_done: AtomicBool::new(true),
            runner_owned: AtomicBool::new(false),
            shutdown_requested: AtomicBool::new(false),
        }
    }
}

fn checkpoint_path(data_root: &Path) -> PathBuf {
    data_root.join("recovery-checkpoint.json")
}
fn checkpoint_lifecycle_intent_path(data_root: &Path) -> PathBuf {
    data_root.join("recovery-checkpoint-intent.json")
}
fn checkpoint_lifecycle_ready_path(data_root: &Path) -> PathBuf {
    data_root.join("recovery-checkpoint-ready.json")
}
fn consumed_marker_path(data_root: &Path) -> PathBuf {
    data_root.join("recovery-first-boot-consumed.json")
}
fn verified_marker_path(data_root: &Path) -> PathBuf {
    data_root.join("recovery-checkpoint-verified.json")
}

fn finalized_marker_path(data_root: &Path) -> PathBuf {
    data_root.join("recovery-finalized.json")
}

fn recovery_boot_mode_name(mode: RecoveryBootMode) -> &'static str {
    match mode {
        RecoveryBootMode::Normal => "Normal",
        RecoveryBootMode::FirstBootPending => "FirstBootPending",
        RecoveryBootMode::ActiveQuarantine => "ActiveQuarantine",
        RecoveryBootMode::Blocked => "Blocked",
    }
}

/* A finalize marker is only valid when it is well-formed and pinned to the
   exact checkpoint artifact (planId + lifecycleId + checkpoint file hash). */
fn read_finalized_marker_valid_for(
    data_root: &Path,
    plan_id: &str,
    lifecycle_id: &str,
    checkpoint_file_sha256: &str,
) -> Option<RecoveryFinalizedMarker> {
    let path = finalized_marker_path(data_root);
    if !path.exists() {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let marker: RecoveryFinalizedMarker = serde_json::from_slice(&bytes).ok()?;
    if marker.schema != RECOVERY_FINALIZED_SCHEMA
        || marker.version != 1
        || marker.plan_id != plan_id
        || marker.lifecycle_id != lifecycle_id
        || marker.checkpoint_file_sha256 != checkpoint_file_sha256
        || marker.verified_at.is_empty()
        || marker.authorized_at.is_empty()
        || !is_sha256(&marker.credential_ready_digest)
    {
        return None;
    }
    Some(marker)
}

fn finalized_marker_well_formed(data_root: &Path) -> bool {
    let path = finalized_marker_path(data_root);
    if !path.exists() {
        return false;
    }
    let Ok(bytes) = fs::read(&path) else {
        return false;
    };
    let Ok(marker) = serde_json::from_slice::<RecoveryFinalizedMarker>(&bytes) else {
        return false;
    };
    marker.schema == RECOVERY_FINALIZED_SCHEMA
        && marker.version == 1
        && !marker.plan_id.is_empty()
        && marker.lifecycle_id.len() == 32
        && is_sha256(&marker.checkpoint_file_sha256)
        && !marker.verified_at.is_empty()
        && is_sha256(&marker.credential_ready_digest)
        && !marker.authorized_at.is_empty()
}

fn current_recovery_boot_policy() -> (RecoveryBootPolicy, Option<PathBuf>) {
    match recovery_data_root() {
        Ok(root) => (recovery_boot_policy_from_dir(&root), Some(root)),
        Err(_) => (
            RecoveryBootPolicy {
                mode: RecoveryBootMode::Blocked,
                plan_id: None,
            },
            None,
        ),
    }
}

#[tauri::command]
fn read_recovery_checkpoint() -> Result<Option<RecoveryCheckpoint>, String> {
    let data_root = recovery_data_root()?;
    let path = checkpoint_path(&data_root);
    if !path.exists() {
        if checkpoint_lifecycle_intent_path(&data_root).exists()
            || checkpoint_lifecycle_ready_path(&data_root).exists()
            || verified_marker_path(&data_root).exists()
            || consumed_marker_path(&data_root).exists()
        {
            return Err("RECOVERY_CHECKPOINT_LIFECYCLE_INCOMPLETE".to_string());
        }
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| "RECOVERY_CHECKPOINT_READ_FAILED".to_string())?;
    let checkpoint: RecoveryCheckpoint =
        serde_json::from_slice(&bytes).map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    validate_checkpoint_lifecycle_files(&data_root, &checkpoint, &bytes, true)?;
    Ok(Some(checkpoint))
}

fn c35_recovery_boundary_proof(host: &RecoveryOnlyHostState) -> Result<serde_json::Value, String> {
    if !host.reconstruction_dry_run_only || !host.active_quarantined {
        return Err("C35_RECOVERY_ONLY_HOST_POLICY_INVALID".to_string());
    }
    let data_root = recovery_data_root()?;
    if consumed_marker_path(&data_root).exists() {
        return Err("C35_FIRST_BOOT_CONSUMED_MARKER_PRESENT".to_string());
    }
    #[cfg(windows)]
    let output = {
        let self_pid = std::process::id();
        let script = format!(
            "$selfPid={self_pid}; $rx='(?i)(runtime[\\\\/]+local-services-runner\\.js|services[\\\\/]+(home-node-service|ib-bridge-service|active-message-service|internal-beyond-server)\\.js)'; \
             $nodes=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {{ $_.CommandLine -match $rx }}); \
             $hosts=@(Get-CimInstance Win32_Process -Filter \"Name='internalbeyond-host.exe'\" | Where-Object {{ $_.ProcessId -ne $selfPid }}); \
             $ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {{ $_.LocalPort -in @(8765,23114,23115,23116,23118,23120,23121,23122,43127) }}); \
             [pscustomobject]@{{nodeServiceProcesses=$nodes.Count;otherHostProcesses=$hosts.Count;protectedPortListeners=$ports.Count}} | ConvertTo-Json -Compress"
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .output()
            .map_err(|_| "C35_RUNTIME_BOUNDARY_PROBE_FAILED".to_string())?
    };
    #[cfg(not(windows))]
    return Err("C35_CANONICAL_WINDOWS_HOST_REQUIRED".to_string());

    if !output.status.success() || output.stdout.len() > 16 * 1024 {
        return Err("C35_RUNTIME_BOUNDARY_PROBE_FAILED".to_string());
    }
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "C35_RUNTIME_BOUNDARY_PROBE_INVALID".to_string())?;
    let node_count = probe.get("nodeServiceProcesses").and_then(serde_json::Value::as_u64).unwrap_or(u64::MAX);
    let other_host_count = probe.get("otherHostProcesses").and_then(serde_json::Value::as_u64).unwrap_or(u64::MAX);
    let port_count = probe.get("protectedPortListeners").and_then(serde_json::Value::as_u64).unwrap_or(u64::MAX);
    if node_count != 0 || other_host_count != 0 || port_count != 0 {
        return Err("C35_NORMAL_RUNTIME_OR_PROTECTED_PORT_ACTIVE".to_string());
    }
    Ok(serde_json::json!({
        "recoveryOnly": true,
        "normalRuntimeStopped": true,
        "activeQuarantined": true,
        "consumedMarkerPresent": false,
        "protectedPortsReleased": true,
        "providerCalls": 0,
        "secretAccess": false,
        "specJsonRead": false,
        "specJsonWrite": false,
        "runtimeBindingChanged": false,
        "providerBindingChanged": false,
        "serviceProcessCount": node_count,
        "otherHostProcessCount": other_host_count,
        "protectedPortListenerCount": port_count,
        "hostTargetIdentity": host.target_identity,
        "hostTargetOrigin": host.target_origin
    }))
}

#[cfg(windows)]
#[link(name = "rstrtmgr")]
extern "system" {
    fn RmStartSession(session_handle: *mut u32, flags: u32, session_key: *mut u16) -> u32;
    fn RmRegisterResources(
        session_handle: u32,
        file_count: u32,
        file_names: *const *const u16,
        application_count: u32,
        applications: *const std::ffi::c_void,
        service_count: u32,
        service_names: *const *const u16,
    ) -> u32;
    fn RmGetList(
        session_handle: u32,
        process_info_needed: *mut u32,
        process_info_count: *mut u32,
        affected_apps: *mut std::ffi::c_void,
        reboot_reasons: *mut u32,
    ) -> u32;
    fn RmEndSession(session_handle: u32) -> u32;
}

#[cfg(windows)]
fn c35_windows_resource_holder_count(path: &Path) -> Result<u32, ()> {
    use std::os::windows::ffi::OsStrExt;

    let session_key = uuid::Uuid::new_v4().simple().to_string();
    let mut session_key_wide = session_key.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut session_handle = 0u32;
    let start = unsafe { RmStartSession(&mut session_handle, 0, session_key_wide.as_mut_ptr()) };
    if start != 0 { return Err(()); }

    let query = (|| {
        let path_wide = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
        let path_pointer = path_wide.as_ptr();
        let register = unsafe {
            RmRegisterResources(session_handle, 1, &path_pointer, 0, std::ptr::null(), 0, std::ptr::null())
        };
        if register != 0 { return Err(()); }

        let mut needed = 0u32;
        let mut count = 0u32;
        let mut reboot_reasons = 0u32;
        let result = unsafe {
            RmGetList(session_handle, &mut needed, &mut count, std::ptr::null_mut(), &mut reboot_reasons)
        };
        match result {
            0 if needed == 0 && count == 0 => Ok(0),
            234 => Ok(needed.max(count)),
            _ => Err(()),
        }
    })();
    let end = unsafe { RmEndSession(session_handle) };
    if end != 0 { return Err(()); }
    query
}

fn c35_home_node_sidecar_holder_audit(database_path: &Path) -> serde_json::Value {
    let mut resources = Vec::new();
    let mut available = true;
    for suffix in ["-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{}", database_path.to_string_lossy(), suffix));
        let exists = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            _ => {
                available = false;
                resources.push(serde_json::json!({ "suffix": suffix, "exists": true, "holderCount": null }));
                continue;
            }
        };
        #[cfg(windows)]
        let holder_count = if exists { c35_windows_resource_holder_count(&path).ok() } else { Some(0) };
        #[cfg(not(windows))]
        let holder_count: Option<u32> = if exists { None } else { Some(0) };
        if holder_count.is_none() { available = false; }
        resources.push(serde_json::json!({
            "suffix": suffix,
            "exists": exists,
            "holderCount": holder_count
        }));
    }
    serde_json::json!({
        "schema": "internalbeyond.p32-w5.r3-c3.5-sidecar-holder-audit",
        "method": "WINDOWS_RESTART_MANAGER_READ_ONLY",
        "available": available,
        "resources": resources
    })
}

fn c35_file_sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Some(format!("{:x}", digest.finalize()))
}

#[cfg(windows)]
fn c35_is_plain_drive_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

#[cfg(windows)]
fn c35_is_plain_unc_absolute(value: &str) -> bool {
    if !value.starts_with("\\\\") || value.starts_with("\\\\?\\") || value.starts_with("\\\\.\\") {
        return false;
    }
    let mut components = value[2..].split('\\');
    let server = components.next().unwrap_or_default();
    let share = components.next().unwrap_or_default();
    !server.is_empty() && server != "." && server != ".." && !share.is_empty() && share != "." && share != ".."
}

/* Convert only a safe extended drive path to its equivalent plain Win32 form.
   Extended UNC and device namespaces are rejected explicitly; this helper does
   not guess how to rewrite them. Already-plain absolute drive/UNC paths remain
   unchanged. */
#[cfg(windows)]
fn windows_child_argv_path(path: &Path) -> Result<PathBuf, String> {
    let value = path.to_string_lossy();
    if value.starts_with("\\\\?\\UNC\\") {
        return Err("C35_CHILD_ARGV_EXTENDED_UNC_UNSUPPORTED".to_string());
    }
    if value.starts_with("\\\\?\\") {
        let plain = value
            .strip_prefix("\\\\?\\")
            .ok_or_else(|| "C35_CHILD_ARGV_PATH_FORMAT_UNSUPPORTED".to_string())?;
        if !c35_is_plain_drive_absolute(plain) {
            return Err("C35_CHILD_ARGV_EXTENDED_PATH_UNSUPPORTED".to_string());
        }
        return Ok(PathBuf::from(plain));
    }
    if c35_is_plain_drive_absolute(&value) || c35_is_plain_unc_absolute(&value) {
        return Ok(path.to_path_buf());
    }
    Err("C35_CHILD_ARGV_PATH_NOT_ABSOLUTE".to_string())
}

#[cfg(not(windows))]
fn windows_child_argv_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Err("C35_CHILD_ARGV_PATH_NOT_ABSOLUTE".to_string())
    }
}

/* The caller supplies a canonical, in-root source path. Resolve the normalized
   argv path again and compare both canonical identity and bytes before spawn. */
fn c35_normalized_child_script_argv(source: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
    if !source.is_absolute() || !source.starts_with(canonical_root) {
        return Err("C35_CHILD_ARGV_SOURCE_OUTSIDE_ROOT".to_string());
    }
    let canonical_source = fs::canonicalize(source).map_err(|_| "C35_CHILD_ARGV_SOURCE_UNRESOLVED".to_string())?;
    if canonical_source != source {
        return Err("C35_CHILD_ARGV_SOURCE_NOT_CANONICAL".to_string());
    }
    let normalized = windows_child_argv_path(source)?;
    let canonical_target = fs::canonicalize(&normalized).map_err(|_| "C35_CHILD_ARGV_TARGET_UNRESOLVED".to_string())?;
    if canonical_target != canonical_source {
        return Err("C35_CHILD_ARGV_IDENTITY_MISMATCH".to_string());
    }
    let source_hash = c35_file_sha256(&canonical_source).ok_or_else(|| "C35_CHILD_ARGV_SOURCE_HASH_UNAVAILABLE".to_string())?;
    let target_hash = c35_file_sha256(&normalized).ok_or_else(|| "C35_CHILD_ARGV_TARGET_HASH_UNAVAILABLE".to_string())?;
    if source_hash != target_hash {
        return Err("C35_CHILD_ARGV_CONTENT_MISMATCH".to_string());
    }
    Ok(normalized)
}

fn c35_selected_environment_hashes() -> serde_json::Value {
    let names = ["PATH", "NODE_PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "ComSpec", "PATHEXT", "NODE_OPTIONS"];
    let mut values = serde_json::Map::new();
    for name in names {
        let value = std::env::var(name).ok();
        values.insert(name.to_string(), serde_json::json!({
            "present": value.is_some(),
            "sha256": value.as_ref().map(|text| sha256_hex(text.as_bytes()))
        }));
    }
    serde_json::Value::Object(values)
}

#[cfg(windows)]
#[repr(C)]
struct C35SidAndAttributes {
    sid: *mut std::ffi::c_void,
    attributes: u32,
}

#[cfg(windows)]
#[repr(C)]
struct C35TokenMandatoryLabel {
    label: C35SidAndAttributes,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn ProcessIdToSessionId(process_id: u32, session_id: *mut u32) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: *mut std::ffi::c_void, desired_access: u32, token: *mut *mut std::ffi::c_void) -> i32;
    fn GetTokenInformation(token: *mut std::ffi::c_void, information_class: i32, information: *mut std::ffi::c_void, information_length: u32, return_length: *mut u32) -> i32;
    fn GetSidSubAuthorityCount(sid: *mut std::ffi::c_void) -> *mut u8;
    fn GetSidSubAuthority(sid: *mut std::ffi::c_void, index: u32) -> *mut u32;
}

#[cfg(windows)]
fn c35_process_session_id() -> Option<u32> {
    let mut session = 0u32;
    let ok = unsafe { ProcessIdToSessionId(std::process::id(), &mut session) };
    (ok != 0).then_some(session)
}

#[cfg(not(windows))]
fn c35_process_session_id() -> Option<u32> { None }

#[cfg(windows)]
fn c35_process_integrity_level() -> String {
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_INTEGRITY_LEVEL: i32 = 25;
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return "UNAVAILABLE".to_string();
    }
    let mut needed = 0u32;
    let _ = unsafe { GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, std::ptr::null_mut(), 0, &mut needed) };
    if needed < std::mem::size_of::<C35TokenMandatoryLabel>() as u32 {
        unsafe { CloseHandle(token); }
        return "UNAVAILABLE".to_string();
    }
    let words = ((needed as usize) + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
    let mut storage = vec![0usize; words];
    let success = unsafe {
        GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, storage.as_mut_ptr() as *mut std::ffi::c_void, needed, &mut needed)
    };
    let level = if success == 0 {
        "UNAVAILABLE"
    } else {
        let label = unsafe { &*(storage.as_ptr() as *const C35TokenMandatoryLabel) };
        if label.label.sid.is_null() {
            "UNAVAILABLE"
        } else {
            let count = unsafe { GetSidSubAuthorityCount(label.label.sid) };
            if count.is_null() || unsafe { *count } == 0 {
                "UNAVAILABLE"
            } else {
                let rid_ptr = unsafe { GetSidSubAuthority(label.label.sid, u32::from(*count) - 1) };
                if rid_ptr.is_null() { "UNAVAILABLE" } else {
                    match unsafe { *rid_ptr } {
                        rid if rid < 0x1000 => "UNTRUSTED",
                        rid if rid < 0x2000 => "LOW",
                        rid if rid < 0x3000 => "MEDIUM",
                        rid if rid < 0x4000 => "HIGH",
                        rid if rid < 0x5000 => "SYSTEM",
                        _ => "PROTECTED",
                    }
                }
            }
        }
    };
    unsafe { CloseHandle(token); }
    level.to_string()
}

#[cfg(not(windows))]
fn c35_process_integrity_level() -> String { "UNAVAILABLE".to_string() }

fn c35_host_invocation_snapshot(root: &Path, node: &Path, runner_source: &Path, runner_argv: &Path) -> serde_json::Value {
    let host_executable = std::env::current_exe().ok();
    let host_cwd = std::env::current_dir().ok();
    let host_arguments = std::env::args().collect::<Vec<_>>();
    let host_arguments_bytes = serde_json::to_vec(&host_arguments).unwrap_or_default();
    let child_arguments = vec![node.to_string_lossy().to_string(), runner_argv.to_string_lossy().to_string(), C35_RECONSTRUCTION_DRY_RUN_ARG.to_string()];
    let child_arguments_bytes = serde_json::to_vec(&child_arguments).unwrap_or_default();
    let runner_source_sha = c35_file_sha256(runner_source);
    let runner_argv_sha = c35_file_sha256(runner_argv);
    let runner_argv_style = if runner_argv.to_string_lossy().starts_with("\\\\?\\") {
        "EXTENDED_LENGTH"
    } else {
        "PLAIN_WIN32_OR_NATIVE_ABSOLUTE"
    };
    serde_json::json!({
        "hostPid": std::process::id(),
        "hostExecutableSha256": host_executable.as_ref().and_then(|path| c35_file_sha256(path)),
        "hostCwdSha256": host_cwd.as_ref().map(|path| sha256_hex(path.to_string_lossy().as_bytes())),
        "nodeExecutableSha256": c35_file_sha256(node),
        "runnerSha256": runner_source_sha.clone(),
        "runnerArgvTargetSha256": runner_argv_sha.clone(),
        "runnerSourceAndArgvTargetBytesMatch": runner_source_sha.is_some() && runner_source_sha == runner_argv_sha,
        "runnerArgvPathStyle": runner_argv_style,
        "childCwdSha256": sha256_hex(root.to_string_lossy().as_bytes()),
        "hostArgvCount": host_arguments.len(),
        "hostArgvCanonicalSha256": sha256_hex(&host_arguments_bytes),
        "childArgvCount": child_arguments.len(),
        "childArgvCanonicalSha256": sha256_hex(&child_arguments_bytes),
        "selectedEnvironmentPresenceAndHashes": c35_selected_environment_hashes(),
        "sessionId": c35_process_session_id(),
        "integrityLevel": c35_process_integrity_level()
    })
}

fn c35_ui_request_binding(request_schema: &str, request_version: u8) -> Result<serde_json::Value, String> {
    if request_schema != C35_UI_DRY_RUN_REQUEST_SCHEMA || request_version != 1 {
        return Err("C35_UI_REQUEST_IDENTITY_INVALID".to_string());
    }
    let descriptor = serde_json::json!({
        "command": "p32_w5_r3_c3_5_reconstruction_dry_run",
        "args": { "requestSchema": request_schema, "requestVersion": request_version }
    });
    let bytes = serde_json::to_vec(&descriptor).map_err(|_| "C35_UI_REQUEST_HASH_FAILED".to_string())?;
    Ok(serde_json::json!({
        "schema": request_schema,
        "version": request_version,
        "canonicalRequestSha256": sha256_hex(&bytes),
        "fieldNames": ["requestSchema", "requestVersion"],
        "requiredFieldPresence": { "requestSchema": true, "requestVersion": true }
    }))
}

fn c35_validate_ui_request_binding(request_schema: &str, request_version: u8) -> Result<(), String> {
    if request_schema == C35_UI_DRY_RUN_REQUEST_SCHEMA && request_version == 1 {
        Ok(())
    } else {
        Err("C35_UI_REQUEST_IDENTITY_INVALID".to_string())
    }
}

fn c35_child_probe_request_binding(request_schema: &str, request_version: u8) -> Result<serde_json::Value, String> {
    if request_schema != C35_CHILD_PROBE_REQUEST_SCHEMA || request_version != 1 {
        return Err("C35_CHILD_PROBE_REQUEST_INVALID".to_string());
    }
    let descriptor = serde_json::json!({
        "command": "p32_w5_r3_c3_5_child_process_boundary_probe",
        "args": { "requestSchema": request_schema, "requestVersion": request_version }
    });
    let bytes = serde_json::to_vec(&descriptor).map_err(|_| "C35_CHILD_PROBE_REQUEST_HASH_FAILED".to_string())?;
    Ok(serde_json::json!({
        "schema": request_schema,
        "version": request_version,
        "fieldNames": ["requestSchema", "requestVersion"],
        "requiredFieldPresence": { "requestSchema": true, "requestVersion": true },
        "canonicalRequestSha256": sha256_hex(&bytes)
    }))
}

struct C35NativeChildCapture {
    spawn_markers: Vec<&'static str>,
    output: Option<Output>,
    spawn_failed: bool,
    stdin_write_failed: bool,
    wait_failed: bool,
}

/* Shared native spawn helper for the RecoveryOnly runner and its inert child
   boundary probe. Keep command construction centralized so the synthetic
   probe exercises the same executable, cwd, inherited environment, piped
   stdio, shell-free launch, and Windows creation flags. */
fn c35_spawn_native_child(
    executable: &Path,
    arguments: &[OsString],
    cwd: &Path,
    stdin_payload: Option<&[u8]>,
) -> C35NativeChildCapture {
    let mut spawn_markers = vec!["C35_CHILD_SPAWN_ATTEMPTED"];
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return C35NativeChildCapture {
            spawn_markers,
            output: None,
            spawn_failed: true,
            stdin_write_failed: false,
            wait_failed: false,
        },
    };
    spawn_markers.push("C35_CHILD_PROCESS_STARTED");

    let stdin_write_failed = match (child.stdin.take(), stdin_payload) {
        (Some(mut stdin), Some(payload)) => stdin.write_all(payload).is_err(),
        (Some(stdin), None) => { drop(stdin); false },
        (None, Some(_)) => true,
        (None, None) => false,
    };
    /* Taking and dropping the pipe above sends EOF before wait_with_output. */
    let output = child.wait_with_output().ok();
    let wait_failed = output.is_none();
    if output.is_some() {
        spawn_markers.push("C35_CHILD_EXIT_RECEIVED");
    }
    C35NativeChildCapture {
        spawn_markers,
        output,
        spawn_failed: false,
        stdin_write_failed,
        wait_failed,
    }
}

fn c35_native_spawn_context(root: &Path, executable: &Path, arguments: &[OsString]) -> serde_json::Value {
    let host_executable = std::env::current_exe().ok();
    let all_arguments = std::iter::once(executable.to_string_lossy().to_string())
        .chain(arguments.iter().map(|argument| argument.to_string_lossy().to_string()))
        .collect::<Vec<_>>();
    let argument_bytes = serde_json::to_vec(&all_arguments).unwrap_or_default();
    let argument_texts = arguments.iter().map(|argument| argument.to_string_lossy()).collect::<Vec<_>>();
    serde_json::json!({
        "executableSha256": c35_file_sha256(executable),
        "argumentCount": arguments.len(),
        "argvCanonicalSha256": sha256_hex(&argument_bytes),
        "argumentContainsSpace": argument_texts.iter().any(|argument| argument.contains(' ')),
        "argumentContainsNonAscii": argument_texts.iter().any(|argument| !argument.is_ascii()),
        "cwdSha256": sha256_hex(root.to_string_lossy().as_bytes()),
        "environmentPresenceAndHashes": c35_selected_environment_hashes(),
        "parent": {
            "pid": std::process::id(),
            "executableSha256": host_executable.as_ref().and_then(|path| c35_file_sha256(path)),
            "sessionId": c35_process_session_id(),
            "integrityLevel": c35_process_integrity_level()
        },
        "stdio": { "stdin": "piped-empty-then-closed", "stdout": "piped-captured", "stderr": "piped-captured" },
        "environmentInherited": true,
        "explicitEnvironmentOverrides": 0,
        "shell": false,
        "windowsCreationFlags": if cfg!(windows) { "CREATE_NO_WINDOW (0x08000000)" } else { "not-applicable" },
        "argumentEncoding": if cfg!(windows) { "Rust OsStr to Windows UTF-16 command line" } else { "platform-native OsStr" },
        "cwdIdentity": "canonical-install-root"
    })
}

#[tauri::command(rename_all = "camelCase")]
fn p32_w5_r3_c3_5_child_process_boundary_probe(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecoveryOnlyHostState>,
    lifecycle: tauri::State<'_, RecoveryOnlyLifecycle>,
    request_schema: String,
    request_version: u8,
) -> Result<serde_json::Value, String> {
    let request_binding = c35_child_probe_request_binding(&request_schema, request_version)?;
    let _probe_guard = RecoveryOnlyDryRunGuard::begin(lifecycle.inner(), app.clone())?;
    let host = state.inner();
    if !host.reconstruction_dry_run_only || !host.active_quarantined {
        return Err("C35_CHILD_PROBE_RECOVERYONLY_REQUIRED".to_string());
    }
    let runtime = resolve_runtime_root(&app)?;
    if runtime.mode != RuntimeMode::Production {
        return Err("RECOVERY_ONLY_REQUIRES_CANONICAL_PRODUCTION_ROOT".to_string());
    }
    let root = fs::canonicalize(&runtime.root).map_err(|_| "C35_CANONICAL_ROOT_INVALID".to_string())?;
    let executable = fs::canonicalize(root.join("runtime/node/node.exe"))
        .map_err(|_| "C35_BUNDLED_NODE_MISSING".to_string())?;
    let script = fs::canonicalize(root.join(C35_CHILD_PROBE_SCRIPT_RELATIVE_PATH))
        .map_err(|_| "C35_CHILD_PROBE_SCRIPT_MISSING".to_string())?;
    if !executable.starts_with(&root) || !script.starts_with(&root) {
        return Err("C35_CHILD_PROBE_PATH_ESCAPE".to_string());
    }
    let script_argv = c35_normalized_child_script_argv(&script, &root)?;
    let arguments = vec![script_argv.as_os_str().to_os_string()];
    let spawn_context = c35_native_spawn_context(&root, &executable, &arguments);
    let capture = c35_spawn_native_child(&executable, &arguments, &root, None);
    let output = capture.output.as_ref();
    let exit_code = output.and_then(|output| output.status.code());
    let stdout = output.map(|output| output.stdout.as_slice()).unwrap_or_default();
    let stderr = output.map(|output| output.stderr.as_slice()).unwrap_or_default();
    let node_entry_marker_seen = std::str::from_utf8(stdout).ok().map(|text| {
        text.lines().any(|line| line.trim_end_matches('\r') == C35_NODE_ENTRY_MARKER)
    }).unwrap_or(false);
    let passed = !capture.spawn_failed && !capture.wait_failed && !capture.stdin_write_failed
        && exit_code == Some(0) && node_entry_marker_seen
        && stdout == b"C35_NODE_ENTRY_REACHED\n" && stderr.is_empty();
    let failure_code = if passed {
        None
    } else if capture.spawn_failed {
        Some("C35_NATIVE_CHILD_SPAWN_FAILED")
    } else if capture.wait_failed {
        Some("C35_NATIVE_CHILD_WAIT_FAILED")
    } else if capture.stdin_write_failed {
        Some("C35_NATIVE_CHILD_STDIN_FAILED")
    } else if !node_entry_marker_seen {
        Some("C35_NODE_ENTRY_MARKER_MISSING")
    } else {
        Some("C35_NATIVE_CHILD_EXIT_INVALID")
    };
    Ok(serde_json::json!({
        "schema": "internalbeyond.p32-w5.r3-c3.5-child-process-boundary-probe",
        "version": 1,
        "status": if passed { "PASS" } else { "FAIL" },
        "failureCode": failure_code,
        "requestBinding": request_binding,
        "targetIdentitySha256": sha256_hex(host.target_identity.as_bytes()),
        "recoveryOnly": true,
        "activeQuarantined": host.active_quarantined,
        "nativeSpawnMarkers": capture.spawn_markers,
        "child": {
            "exitCode": exit_code,
            "stdoutBytes": stdout.len(),
            "stdoutSha256": sha256_hex(stdout),
            "stderrBytes": stderr.len(),
            "stderrSha256": sha256_hex(stderr),
            "nodeEntryMarkerSeen": node_entry_marker_seen,
            "rawStdoutReturned": false,
            "rawStderrReturned": false
        },
        "spawnContext": spawn_context,
        "safety": {
            "databaseOpened": false,
            "businessDataRead": false,
            "credentialRead": false,
            "vaultDecrypted": false,
            "providerCalls": 0,
            "reconstructionWrites": 0,
            "homeNodeWrites": 0,
            "indexedDbWrites": 0,
            "approvalIssued": 0,
            "checkpointCreated": 0,
            "applyWindowOpened": 0,
            "writeAllowed": false,
            "applyAllowed": false
        }
    }))
}

#[tauri::command(rename_all = "camelCase")]
fn p32_w5_r3_c3_5_reconstruction_dry_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecoveryOnlyHostState>,
    lifecycle: tauri::State<'_, RecoveryOnlyLifecycle>,
    request_schema: String,
    request_version: u8,
) -> Result<serde_json::Value, String> {
    c35_validate_ui_request_binding(&request_schema, request_version)?;
    let mut request_binding = c35_ui_request_binding(&request_schema, request_version)?;
    /* The guard spans proof, runner execution, adapter close in the runner's
    finally block, and report persistence. A pending last-window exit is only
    released when this whole native command has returned from that work. */
    let _dry_run_guard = RecoveryOnlyDryRunGuard::begin(lifecycle.inner(), app.clone())?;
    let host = state.inner();
    let mut native_proof = c35_recovery_boundary_proof(host)?;
    let runtime = resolve_runtime_root(&app)?;
    if runtime.mode != RuntimeMode::Production {
        return Err("RECOVERY_ONLY_REQUIRES_CANONICAL_PRODUCTION_ROOT".to_string());
    }
    let root = fs::canonicalize(&runtime.root).map_err(|_| "C35_CANONICAL_ROOT_INVALID".to_string())?;
    recovery_payload_is_complete(&root)?;
    let node = fs::canonicalize(root.join("runtime/node/node.exe"))
        .map_err(|_| "C35_BUNDLED_NODE_MISSING".to_string())?;
    let runner = fs::canonicalize(root.join("services/home-node/reconstruction-runner.js"))
        .map_err(|_| "C35_RUNNER_MISSING".to_string())?;
    if !node.starts_with(&root) || !runner.starts_with(&root) {
        return Err("C35_RUNNER_PATH_ESCAPE".to_string());
    }
    let runner_argv = c35_normalized_child_script_argv(&runner, &root)?;
    let host_invocation_snapshot = c35_host_invocation_snapshot(&root, &node, &runner, &runner_argv);
    let local_app_data = std::env::var("LOCALAPPDATA").map_err(|_| "C35_LOCALAPPDATA_UNAVAILABLE".to_string())?;
    let expected_home_node_path = PathBuf::from(&local_app_data)
        .join(C35_HOME_NODE_TARGET_RELATIVE_PATH)
        .to_string_lossy()
        .to_string();
    let sidecar_holder_audit = c35_home_node_sidecar_holder_audit(Path::new(&expected_home_node_path));
    native_proof.as_object_mut()
        .ok_or_else(|| "C35_NATIVE_PROOF_INVALID".to_string())?
        .insert("homeNodeSidecarHolderAudit".to_string(), sidecar_holder_audit);
    let request = serde_json::json!({
        "schema": C35_RECONSTRUCTION_DRY_RUN_SCHEMA,
        "version": C35_RECONSTRUCTION_DRY_RUN_REQUEST_VERSION,
        "mode": "RECOVERY_ONLY_DRY_RUN",
        "localAppData": local_app_data,
        "nativeProof": native_proof
    });
    let request_bytes = serde_json::to_vec(&request).map_err(|_| "C35_REQUEST_SERIALIZE_FAILED".to_string())?;
    if let Some(binding) = request_binding.as_object_mut() {
        binding.insert("runnerRequestSchema".to_string(), serde_json::json!(C35_RECONSTRUCTION_DRY_RUN_SCHEMA));
        binding.insert("runnerRequestVersion".to_string(), serde_json::json!(C35_RECONSTRUCTION_DRY_RUN_REQUEST_VERSION));
        binding.insert("runnerRequestCanonicalSha256".to_string(), serde_json::json!(sha256_hex(&request_bytes)));
        binding.insert("runnerRequestFieldNames".to_string(), serde_json::json!([
            "localAppData", "mode", "nativeProof", "schema", "version"
        ]));
        binding.insert("nativeProofFieldNames".to_string(), serde_json::json!([
            "activeQuarantined", "consumedMarkerPresent", "homeNodeSidecarHolderAudit",
            "normalRuntimeStopped", "otherHostProcessCount", "protectedPortListenerCount",
            "providerBindingChanged", "providerCalls", "recoveryOnly", "runtimeBindingChanged",
            "secretAccess", "serviceProcessCount", "specJsonRead", "specJsonWrite"
        ]));
    }
    let child_arguments = vec![runner_argv.as_os_str().to_os_string(), OsString::from(C35_RECONSTRUCTION_DRY_RUN_ARG)];
    let capture = c35_spawn_native_child(&node, &child_arguments, &root, Some(&request_bytes));
    if capture.spawn_failed {
        return Err("C35_RUNNER_START_FAILED".to_string());
    }
    let output = capture.output.ok_or_else(|| "C35_RUNNER_WAIT_FAILED".to_string())?;
    if capture.stdin_write_failed {
        return Err("C35_RUNNER_REQUEST_FAILED".to_string());
    }
    let exit_code = output.status.code();
    let mut checked = c35_check_runner_output(exit_code, &output.stdout, &output.stderr, &expected_home_node_path);
    if let Some(diagnostic) = checked.diagnostic.as_object_mut() {
        diagnostic.insert("hostInvocationSnapshot".to_string(), host_invocation_snapshot);
        diagnostic.insert("requestBinding".to_string(), request_binding);
        diagnostic.insert("childSpawnMarkers".to_string(), serde_json::json!(capture.spawn_markers));
    }
    if let Some(reason_code) = checked.reason_code.clone() {
        let diagnostic_id = uuid::Uuid::new_v4().simple().to_string();
        let diagnostic_path = recovery_data_root()?
            .join("reconstruction-reports")
            .join(format!("p32w5-r3c3-c3.5-diagnostic-{diagnostic_id}.json"));
        let _ = write_new_json(&diagnostic_path, &checked.diagnostic);
        return Err(reason_code);
    }
    let report = checked.report.ok_or_else(|| "C35_RUNNER_OUTPUT_INTERNAL_INVALID".to_string())?;
    let identity = report.get("executionIdentity").and_then(serde_json::Value::as_str).unwrap_or("");
    let safe_identity = identity.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_').take(96).collect::<String>();
    if safe_identity.is_empty() {
        return Err("C35_DRYRUN_EXECUTION_ID_INVALID".to_string());
    }
    let report_dir = recovery_data_root()?.join("reconstruction-reports");
    let report_path = report_dir.join(format!("p32w5-r3c3-c3.5-{safe_identity}.json"));
    write_new_json(&report_path, &report)?;
    Ok(serde_json::json!({ "report": report, "reportPath": report_path, "runnerDiagnostics": checked.diagnostic }))
}

struct C35RunnerOutputCheck {
    report: Option<serde_json::Value>,
    reason_code: Option<String>,
    diagnostic: serde_json::Value,
}

fn c35_safe_reason_code(value: &str) -> Option<String> {
    if value == "A_DUPLICATE_CONTENT_CONFLICT" {
        return Some(value.to_string());
    }
    let bytes = value.as_bytes();
    if bytes.len() < 5 || bytes.len() > 96 || !(value.starts_with("C34_") || value.starts_with("C35_")) {
        return None;
    }
    if bytes.iter().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_') {
        Some(value.to_string())
    } else {
        None
    }
}

fn c35_sanitized_stderr_code(stderr: &[u8]) -> Option<String> {
    const KNOWN: [&str; 8] = [
        "C35_HOME_NODE_WAL_OR_SHM_PRESENT",
        "C35_HOME_NODE_SIDECAR_INVALID",
        "C35_HOME_NODE_TARGET_HASH_MISMATCH",
        "C35_QUERY_ONLY_CONNECTION_REQUIRED",
        "C35_NATIVE_PROOF_INVALID",
        "C35_RUNNER_FAILED",
        "MODULE_NOT_FOUND",
        "ERR_DLOPEN_FAILED",
    ];
    KNOWN.iter().find(|code| stderr.windows(code.len()).any(|window| window == code.as_bytes()))
        .map(|code| (*code).to_string())
}

fn c35_sanitized_bootstrap_markers(stderr: &[u8]) -> Vec<String> {
    const ALLOWED: [&str; 13] = [
        "C35_NODE_ENTRY_REACHED",
        "C35_BOOTSTRAP_STARTED",
        "C35_BOOTSTRAP_MODULES_OK",
        "C35_BOOTSTRAP_ARGS_OK",
        "C35_BOOTSTRAP_ARGS_REJECTED",
        "C35_BOOTSTRAP_ADAPTER_BEGIN",
        "C35_BOOTSTRAP_ADAPTER_OK",
        "C35_BOOTSTRAP_ADAPTER_FAILED",
        "C35_BOOTSTRAP_PREFLIGHT_BEGIN",
        "C35_BOOTSTRAP_PREFLIGHT_OK",
        "C35_BOOTSTRAP_PREFLIGHT_FAILED",
        "C35_BOOTSTRAP_REQUEST_REJECTED",
        "C35_BOOTSTRAP_MAIN_CAUGHT",
    ];
    std::str::from_utf8(stderr).ok().map(|text| {
        text.lines().map(str::trim)
            .filter(|line| ALLOWED.contains(line))
            .map(str::to_string)
            .collect::<Vec<_>>()
    }).unwrap_or_default()
}

fn c35_runner_diagnostic_value(
    exit_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
    stage: &str,
    reason_code: Option<&str>,
    report: Option<&serde_json::Value>,
) -> serde_json::Value {
    let stdout_utf8_valid = std::str::from_utf8(stdout).is_ok();
    let stderr_utf8_valid = std::str::from_utf8(stderr).is_ok();
    let sanitized_stderr_code = c35_sanitized_stderr_code(stderr);
    let bootstrap_stages = c35_sanitized_bootstrap_markers(stderr);
    let stderr_lines = std::str::from_utf8(stderr).ok().map(|text| text.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>()).unwrap_or_default();
    let stderr_classification = if stderr.is_empty() {
        "EMPTY"
    } else if !stderr_utf8_valid {
        "NON_UTF8_TEXT"
    } else if sanitized_stderr_code.is_some() {
        "KNOWN_SAFE_CODE"
    } else if !bootstrap_stages.is_empty() && stderr_lines.len() == bootstrap_stages.len() {
        "BOOTSTRAP_MARKERS_ONLY"
    } else if stderr.windows(6).any(|window| window == b"Error:")
        || stderr.windows(10).any(|window| window == b"Exception:")
        || stderr.windows(4).any(|window| window == b" at ")
    {
        "RUNTIME_ERROR_TEXT"
    } else {
        "UNCLASSIFIED_NONEMPTY"
    };
    let report_metadata = report.map(|value| {
        let top_level_keys = value.as_object().map(|object| {
            object.keys().map(String::as_str).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>()
        }).unwrap_or_default();
        let safe_code = |key: &str| value.get(key).and_then(serde_json::Value::as_str)
            .and_then(c35_safe_reason_code);
        serde_json::json!({
            "topLevelKeys": top_level_keys,
            "schema": value.get("schema"),
            "reportType": value.get("reportType"),
            "version": value.get("version"),
            "status": value.get("status"),
            "bootstrapStages": bootstrap_stages.clone(),
            "failureCode": safe_code("failureCode"),
            "reasonCode": safe_code("reasonCode"),
            "sidecarMetadataHash": value.get("sidecarMetadataHash").and_then(serde_json::Value::as_str).filter(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }),
            "blockerCodes": value.get("blockers").and_then(serde_json::Value::as_array).map(|items| {
                items.iter().filter_map(serde_json::Value::as_str).filter_map(c35_safe_reason_code).collect::<Vec<_>>()
            }).unwrap_or_default(),
            "bundleIdentity": {
                "bundleId": value.pointer("/bundleIdentity/bundleId"),
                "bundleSha256": value.pointer("/bundleIdentity/bundleSha256")
            },
            "writeSetIdentities": {
                "A": value.pointer("/writeSetIdentities/A"),
                "B": value.pointer("/writeSetIdentities/B")
            },
            "writeSetSummary": {
                "APlanned": value.pointer("/writeSetA/planned"),
                "AOperationCounts": value.pointer("/writeSetA/operationCounts"),
                "BPlanned": value.pointer("/writeSetB/planned"),
                "BOperationCounts": value.pointer("/writeSetB/operationCounts")
            },
            "targetIdentity": {
                "databaseName": value.pointer("/targetIdentity/databaseName"),
                "path": value.pointer("/targetIdentity/path"),
                "databaseSha256": value.pointer("/targetIdentity/c1ObservedDatabaseSha256"),
                "schemaUserVersion": value.pointer("/targetIdentity/schemaUserVersion")
            },
            "activity": value.get("activity")
        })
    });
    serde_json::json!({
        "schema": "internalbeyond.p32-w5.r3-c3.5-native-runner-diagnostic",
        "version": 1,
        "failureStage": stage,
        "reasonCode": reason_code,
        "processExitCode": exit_code,
        "stdout": {
            "byteLength": stdout.len(),
            "sha256": sha256_hex(stdout),
            "validUtf8": stdout_utf8_valid
        },
        "stderr": {
            "byteLength": stderr.len(),
            "sha256": sha256_hex(stderr),
            "validUtf8": stderr_utf8_valid,
            "classification": stderr_classification,
            "sanitizedKnownCode": sanitized_stderr_code
        },
        "bootstrapStages": bootstrap_stages,
        "reportMetadata": report_metadata
    })
}

fn c35_report_stage(stage: &str) -> bool {
    matches!(stage,
        "request_validation" | "runner_initialization" | "adapter_open" | "frozen_input" |
        "bundle_validation" | "runtime_boundary" | "target_identity" | "authority_binding" |
        "write_set_a_preflight" | "write_set_b_preflight" | "provenance" |
        "target_revalidation" | "activity_counters" | "duplicate_policy")
}

fn c35_stage_allows_null(stage: &str, field: &str) -> bool {
    let before_adapter = matches!(stage, "request_validation" | "runner_initialization" | "adapter_open" | "frozen_input");
    let before_target = before_adapter || matches!(stage, "bundle_validation" | "runtime_boundary" | "target_identity");
    match field {
        "targetIdentity" => before_target,
        "authorityArtifacts" => before_target || stage == "authority_binding",
        "writeSetA" => before_target || stage == "authority_binding" || stage == "write_set_a_preflight",
        "writeSetB" => before_target || stage == "authority_binding" || stage == "write_set_a_preflight" || stage == "write_set_b_preflight",
        "provenance" => before_target || stage == "authority_binding" || stage == "write_set_a_preflight"
            || stage == "write_set_b_preflight" || stage == "provenance",
        _ => false,
    }
}

fn c35_validate_activity(report: &serde_json::Value) -> Result<(), String> {
    let activity = report.get("activity").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_ACTIVITY_MISSING".to_string())?;
    for key in ["productionWrites", "homeNodeWrites", "indexedDbWrites", "providerCalls", "secretAccess",
        "specJsonReads", "specJsonWrites", "approvalIssued", "checkpointCreated", "applyWindowOpened"] {
        let count = activity.get(key).ok_or_else(|| "C35_REPORT_ACTIVITY_FIELD_MISSING".to_string())?;
        if count.as_u64() != Some(0) {
            return Err(if count.is_number() { "C35_DRYRUN_ZERO_WRITE_ASSERTION_FAILED" } else { "C35_REPORT_ACTIVITY_TYPE_INVALID" }.to_string());
        }
    }
    Ok(())
}

fn c35_validate_operation_counts(
    report: &serde_json::Value,
    name: &str,
    planned: u64,
    insert: u64,
    update: u64,
    delete: u64,
) -> Result<(), String> {
    let value = report.get(name).and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_WRITESET_MISSING".to_string())?;
    if value.get("planned").and_then(serde_json::Value::as_u64) != Some(planned) {
        return Err("C35_REPORT_WRITESET_COUNT_INVALID".to_string());
    }
    let counts = value.get("operationCounts").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_WRITESET_COUNTS_MISSING".to_string())?;
    if counts.get("INSERT").and_then(serde_json::Value::as_u64) != Some(insert)
        || counts.get("UPDATE").and_then(serde_json::Value::as_u64) != Some(update)
        || counts.get("DELETE").and_then(serde_json::Value::as_u64) != Some(delete)
    {
        return Err("C35_REPORT_WRITESET_COUNTS_INVALID".to_string());
    }
    Ok(())
}

fn c35_object_has_exact_keys(value: &serde_json::Value, expected: &[&str]) -> bool {
    value.as_object().map(|object| {
        object.len() == expected.len() && object.keys().all(|key| expected.contains(&key.as_str()))
    }).unwrap_or(false)
}

fn c35_is_sha256(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_str).map(|text| {
        text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }).unwrap_or(false)
}

fn c35_validate_sidecar_target_identity(target: &serde_json::Value, expected_target_path: &str) -> Result<(), String> {
    if !c35_object_has_exact_keys(target, &["databaseName", "path", "c1ObservedDatabaseSha256", "identityBinding"])
        || target.get("databaseName").and_then(serde_json::Value::as_str) != Some("home-node.db")
        || target.get("path").and_then(serde_json::Value::as_str)
            .map(|path| path.replace('/', "\\").trim_end_matches('\\').eq_ignore_ascii_case(expected_target_path.trim_end_matches('\\'))) != Some(true)
        || target.get("c1ObservedDatabaseSha256").and_then(serde_json::Value::as_str) != Some(C35_HOME_NODE_TARGET_SHA256)
        || target.get("identityBinding").and_then(serde_json::Value::as_str) != Some("FROZEN_C1_DATABASE_SHA256_MATCH") {
        return Err("C35_REPORT_TARGET_IDENTITY_MISMATCH".to_string());
    }
    Ok(())
}

fn c35_validate_invalid_sidecar_failure(report: &serde_json::Value, expected_target_path: &str) -> Result<(), String> {
    const TOP_LEVEL_KEYS: [&str; 27] = [
        "schema", "reportType", "version", "executionIdentity", "generatedAtUtc", "planIdentity",
        "bundleIdentity", "writeSetIdentities", "targetIdentity", "status", "ok", "writeAllowed",
        "applyAllowed", "writesStarted", "automaticRepair", "blockers", "failureCode", "reasonCode",
        "failureStage", "writeSetA", "writeSetB", "provenance", "authorityArtifacts", "activity",
        "sidecarMetadataHash", "sidecarAudit", "runtimeBoundary",
    ];
    if report.as_object().map(|object| object.keys().all(|key| TOP_LEVEL_KEYS.contains(&key.as_str()))).unwrap_or(false) != true {
        return Err("C35_REPORT_SIDECAR_FAILURE_FIELDS_INVALID".to_string());
    }
    if report.get("ok").and_then(serde_json::Value::as_bool) != Some(false)
        || report.get("writeAllowed").and_then(serde_json::Value::as_bool) != Some(false)
        || report.get("applyAllowed").and_then(serde_json::Value::as_bool) != Some(false)
        || report.get("reasonCode").and_then(serde_json::Value::as_str)
            != report.get("failureCode").and_then(serde_json::Value::as_str) {
        return Err("C35_REPORT_SIDECAR_FAILURE_POLICY_INVALID".to_string());
    }
    let target = report.get("targetIdentity").ok_or_else(|| "C35_REPORT_TARGET_IDENTITY_MISSING".to_string())?;
    c35_validate_sidecar_target_identity(target, expected_target_path)?;

    let metadata_hash = report.get("sidecarMetadataHash");
    if !c35_is_sha256(metadata_hash) { return Err("C35_REPORT_SIDECAR_METADATA_HASH_INVALID".to_string()); }
    let audit = report.get("sidecarAudit").ok_or_else(|| "C35_REPORT_SIDECAR_AUDIT_MISSING".to_string())?;
    if !c35_object_has_exact_keys(audit, &["schema", "version", "metadataHash", "entries", "holderAudit"])
        || audit.get("schema").and_then(serde_json::Value::as_str) != Some("internalbeyond.p32-w5.r3-c3.5-sidecar-audit")
        || audit.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || audit.get("metadataHash") != metadata_hash {
        return Err("C35_REPORT_SIDECAR_AUDIT_INVALID".to_string());
    }
    let entries = audit.get("entries").and_then(serde_json::Value::as_array)
        .ok_or_else(|| "C35_REPORT_SIDECAR_ENTRIES_INVALID".to_string())?;
    if entries.len() != 2 { return Err("C35_REPORT_SIDECAR_ENTRIES_INVALID".to_string()); }
    for (entry, suffix) in entries.iter().zip(["-wal", "-shm"]) {
        if !c35_object_has_exact_keys(entry, &["suffix", "exists", "sizeBytes", "sha256", "structureStatus"])
            || entry.get("suffix").and_then(serde_json::Value::as_str) != Some(suffix)
            || entry.get("exists").and_then(serde_json::Value::as_bool).is_none()
            || entry.get("sizeBytes").and_then(serde_json::Value::as_u64).is_none()
            || entry.get("structureStatus").and_then(serde_json::Value::as_str)
                .map(|status| !status.is_empty() && status.len() <= 64 && status.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')) != Some(true) {
            return Err("C35_REPORT_SIDECAR_ENTRY_INVALID".to_string());
        }
        let exists = entry.get("exists").and_then(serde_json::Value::as_bool) == Some(true);
        let digest = entry.get("sha256");
        if (exists && !c35_is_sha256(digest)) || (!exists && !digest.map(serde_json::Value::is_null).unwrap_or(false)) {
            return Err("C35_REPORT_SIDECAR_ENTRY_INVALID".to_string());
        }
    }
    let holder_audit = audit.get("holderAudit").ok_or_else(|| "C35_REPORT_SIDECAR_HOLDER_AUDIT_INVALID".to_string())?;
    if !c35_object_has_exact_keys(holder_audit, &["method", "available", "resources"])
        || holder_audit.get("method").and_then(serde_json::Value::as_str) != Some("WINDOWS_RESTART_MANAGER_READ_ONLY")
        || holder_audit.get("available").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("C35_REPORT_SIDECAR_HOLDER_AUDIT_INVALID".to_string());
    }
    let resources = holder_audit.get("resources").and_then(serde_json::Value::as_array)
        .ok_or_else(|| "C35_REPORT_SIDECAR_HOLDER_AUDIT_INVALID".to_string())?;
    if resources.len() != 2 { return Err("C35_REPORT_SIDECAR_HOLDER_AUDIT_INVALID".to_string()); }
    for (resource, suffix) in resources.iter().zip(["-wal", "-shm"]) {
        if !c35_object_has_exact_keys(resource, &["suffix", "exists", "holderCount"])
            || resource.get("suffix").and_then(serde_json::Value::as_str) != Some(suffix)
            || resource.get("exists") != entries.iter().find(|entry| entry.get("suffix").and_then(serde_json::Value::as_str) == Some(suffix)).and_then(|entry| entry.get("exists"))
            || resource.get("holderCount").and_then(serde_json::Value::as_u64) != Some(0) {
            return Err("C35_REPORT_SIDECAR_HOLDER_PRESENT_OR_UNVERIFIED".to_string());
        }
    }
    if !entries.iter().any(|entry| entry.get("exists").and_then(serde_json::Value::as_bool) == Some(true)
        && entry.get("structureStatus").and_then(serde_json::Value::as_str).map(|status| status.starts_with("INVALID_")).unwrap_or(false)) {
        return Err("C35_REPORT_SIDECAR_INVALID_REASON_UNPROVEN".to_string());
    }
    let basis = serde_json::json!({
        "schema": "internalbeyond.p32-w5.r3-c3.5-sidecar-metadata",
        "version": 1,
        "entries": entries
    });
    let basis_bytes = serde_json::to_vec(&basis).map_err(|_| "C35_REPORT_SIDECAR_METADATA_HASH_INVALID".to_string())?;
    if sha256_hex(&basis_bytes) != metadata_hash.and_then(serde_json::Value::as_str).unwrap_or("") {
        return Err("C35_REPORT_SIDECAR_METADATA_HASH_MISMATCH".to_string());
    }
    Ok(())
}

fn c35_validate_runner_report(report: &serde_json::Value, expected_target_path: &str) -> Result<(), String> {
    if !report.is_object() { return Err("C35_REPORT_TOP_LEVEL_INVALID".to_string()); }
    if report.get("schema").and_then(serde_json::Value::as_str) != Some(C35_RECONSTRUCTION_REPORT_SCHEMA) {
        return Err("C35_REPORT_SCHEMA_INVALID".to_string());
    }
    if report.get("reportType").and_then(serde_json::Value::as_str) != Some(C35_RECONSTRUCTION_REPORT_TYPE) {
        return Err("C35_REPORT_TYPE_INVALID".to_string());
    }
    if report.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("C35_REPORT_VERSION_INVALID".to_string());
    }
    let execution_identity = report.get("executionIdentity").and_then(serde_json::Value::as_str)
        .ok_or_else(|| "C35_REPORT_EXECUTION_IDENTITY_INVALID".to_string())?;
    let execution_uuid = execution_identity.strip_prefix("p32w5-r3c3-c3.5-dryrun:");
    if execution_uuid.map(|value| uuid::Uuid::parse_str(value).is_ok()) != Some(true) {
        return Err("C35_REPORT_EXECUTION_IDENTITY_INVALID".to_string());
    }
    let plan = report.get("planIdentity").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_PLAN_IDENTITY_MISSING".to_string())?;
    if plan.get("planId").and_then(serde_json::Value::as_str) != Some(C35_PLAN_ID)
        || plan.get("planSha256").and_then(serde_json::Value::as_str) != Some(C35_PLAN_SHA256)
        || plan.get("targetSnapshotSha256").and_then(serde_json::Value::as_str) != Some(C35_TARGET_SNAPSHOT_SHA256) {
        return Err("C35_REPORT_PLAN_IDENTITY_MISMATCH".to_string());
    }
    let bundle = report.get("bundleIdentity").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_BUNDLE_IDENTITY_MISSING".to_string())?;
    if bundle.get("bundleId").and_then(serde_json::Value::as_str) != Some(C35_BUNDLE_ID)
        || bundle.get("bundleSha256").and_then(serde_json::Value::as_str) != Some(C35_BUNDLE_SHA256) {
        return Err("C35_REPORT_BUNDLE_IDENTITY_MISMATCH".to_string());
    }
    let write_sets = report.get("writeSetIdentities").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_WRITESET_IDENTITY_MISSING".to_string())?;
    if write_sets.get("A").and_then(serde_json::Value::as_str) != Some(C35_WRITE_SET_A_SHA256)
        || write_sets.get("B").and_then(serde_json::Value::as_str) != Some(C35_WRITE_SET_B_SHA256) {
        return Err("C35_REPORT_WRITESET_IDENTITY_MISMATCH".to_string());
    }
    let status = report.get("status").and_then(serde_json::Value::as_str)
        .ok_or_else(|| "C35_REPORT_STATUS_INVALID".to_string())?;
    if !matches!(status, "DRY_RUN_PASS" | "DRY_RUN_BLOCKED") {
        return Err("C35_REPORT_STATUS_INVALID".to_string());
    }
    if report.get("writesStarted").and_then(serde_json::Value::as_bool) != Some(false)
        || report.get("automaticRepair").and_then(serde_json::Value::as_bool) != Some(false) {
        return Err("C35_REPORT_MUTATION_BOUNDARY_INVALID".to_string());
    }
    let failure_stage = report.get("failureStage").and_then(serde_json::Value::as_str).unwrap_or("");
    let failure_code = report.get("failureCode").and_then(serde_json::Value::as_str);
    if status == "DRY_RUN_BLOCKED" {
        if !c35_report_stage(failure_stage) { return Err("C35_REPORT_FAILURE_STAGE_INVALID".to_string()); }
        let code = failure_code.and_then(c35_safe_reason_code).ok_or_else(|| "C35_REPORT_FAILURE_CODE_INVALID".to_string())?;
        let blockers = report.get("blockers").and_then(serde_json::Value::as_array)
            .ok_or_else(|| "C35_REPORT_BLOCKERS_MISSING".to_string())?;
        if blockers.first().and_then(serde_json::Value::as_str) != Some(code.as_str())
            || blockers.iter().any(|item| item.as_str().and_then(c35_safe_reason_code).is_none()) {
            return Err("C35_REPORT_FAILURE_BLOCKER_MISMATCH".to_string());
        }
        if code == "C35_HOME_NODE_SIDECAR_INVALID" {
            c35_validate_invalid_sidecar_failure(report, expected_target_path)?;
        }
    } else if !report.get("blockers").and_then(serde_json::Value::as_array).map(|items| items.is_empty()).unwrap_or(false) {
        return Err("C35_REPORT_PASS_HAS_BLOCKERS".to_string());
    }
    c35_validate_activity(report)?;
    for (name, planned, insert, update, delete) in [
        ("writeSetA", 500, 500, 0, 0),
        ("writeSetB", 8, 0, 8, 0),
    ] {
        if report.get(name).map(serde_json::Value::is_null).unwrap_or(true) {
            if c35_stage_allows_null(failure_stage, name) && status == "DRY_RUN_BLOCKED" { continue; }
            return Err("C35_REPORT_WRITESET_MISSING".to_string());
        }
        c35_validate_operation_counts(report, name, planned, insert, update, delete)?;
    }
    let target = report.get("targetIdentity");
    let invalid_sidecar_failure = status == "DRY_RUN_BLOCKED" && failure_code == Some("C35_HOME_NODE_SIDECAR_INVALID");
    let sidecar_preflight_failure = status == "DRY_RUN_BLOCKED" && failure_code.map(|code| matches!(code,
        "C35_HOME_NODE_SIDECAR_INVALID" | "C35_HOME_NODE_SIDECAR_HOLDER_PRESENT" |
        "C35_HOME_NODE_SIDECAR_HOLDER_AUDIT_UNAVAILABLE" | "C35_HOME_NODE_SIDECAR_METADATA_UNAVAILABLE" |
        "C35_HOME_NODE_WAL_OR_SHM_PRESENT")).unwrap_or(false);
    if invalid_sidecar_failure {
        /* The invalid-sidecar validator checked the DB hash/path identity without
        opening SQLite, so schema/integrity fields are intentionally not asserted. */
    } else if sidecar_preflight_failure {
        if target.map(serde_json::Value::is_null).unwrap_or(true) {
            if !c35_stage_allows_null(failure_stage, "targetIdentity") {
                return Err("C35_REPORT_TARGET_IDENTITY_MISSING".to_string());
            }
        } else {
            c35_validate_sidecar_target_identity(target.unwrap(), expected_target_path)?;
        }
    } else if target.map(serde_json::Value::is_null).unwrap_or(true) {
        if !(status == "DRY_RUN_BLOCKED" && c35_stage_allows_null(failure_stage, "targetIdentity")) {
            return Err("C35_REPORT_TARGET_IDENTITY_MISSING".to_string());
        }
    } else {
        let target = target.and_then(serde_json::Value::as_object).ok_or_else(|| "C35_REPORT_TARGET_IDENTITY_INVALID".to_string())?;
        if target.get("databaseName").and_then(serde_json::Value::as_str) != Some("home-node.db")
            || target.get("path").and_then(serde_json::Value::as_str)
                .map(|path| path.replace('/', "\\").trim_end_matches('\\').eq_ignore_ascii_case(expected_target_path.trim_end_matches('\\'))) != Some(true)
            || target.get("c1ObservedDatabaseSha256").and_then(serde_json::Value::as_str) != Some(C35_HOME_NODE_TARGET_SHA256)
            || target.get("schemaUserVersion").and_then(serde_json::Value::as_u64) != Some(0)
            || target.get("integrityCheck").and_then(serde_json::Value::as_str) != Some("ok") {
            return Err("C35_REPORT_TARGET_IDENTITY_MISMATCH".to_string());
        }
    }
    if let Some(provenance) = report.get("provenance").filter(|value| !value.is_null()) {
        if provenance.get("recordCount").and_then(serde_json::Value::as_u64) != Some(539)
            || provenance.get("traceDigest").and_then(serde_json::Value::as_str) != Some(C35_PROVENANCE_DIGEST)
            || provenance.get("sourcePrimarySha256").and_then(serde_json::Value::as_str) != Some(C35_SOURCE_PRIMARY_SHA256) {
            return Err("C35_REPORT_PROVENANCE_IDENTITY_MISMATCH".to_string());
        }
    } else if !(status == "DRY_RUN_BLOCKED" && c35_stage_allows_null(failure_stage, "provenance")) {
        return Err("C35_REPORT_PROVENANCE_MISSING".to_string());
    }
    if let Some(authority) = report.get("authorityArtifacts").filter(|value| !value.is_null()) {
        if authority.get("matrixSha256").and_then(serde_json::Value::as_str) != Some(C35_AUTHORITY_MATRIX_SHA256)
            || authority.get("conflictResolutionSha256").and_then(serde_json::Value::as_str) != Some(C35_CONFLICT_RESOLUTION_SHA256)
            || authority.get("c2ReportSha256").and_then(serde_json::Value::as_str) != Some(C35_C2_REPORT_SHA256) {
            return Err("C35_REPORT_AUTHORITY_IDENTITY_MISMATCH".to_string());
        }
    } else if !(status == "DRY_RUN_BLOCKED" && c35_stage_allows_null(failure_stage, "authorityArtifacts")) {
        return Err("C35_REPORT_AUTHORITY_IDENTITY_MISSING".to_string());
    }
    let env = report.get("runtimeBoundary").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "C35_REPORT_RUNTIME_BOUNDARY_MISSING".to_string())?;
    for (field, expected) in [
        ("recoveryOnly", true), ("normalRuntimeStopped", true), ("activeQuarantined", true),
        ("consumedMarkerPresent", false), ("protectedPortsReleased", true),
        ("secretAccess", false), ("specJsonRead", false), ("specJsonWrite", false),
        ("runtimeBindingChanged", false), ("providerBindingChanged", false),
    ] {
        if env.get(field).and_then(serde_json::Value::as_bool) != Some(expected) {
            return Err("C35_REPORT_RUNTIME_BOUNDARY_INVALID".to_string());
        }
    }
    if env.get("providerCalls").and_then(serde_json::Value::as_u64) != Some(0) {
        return Err("C35_REPORT_RUNTIME_BOUNDARY_INVALID".to_string());
    }
    Ok(())
}

fn c35_check_runner_output(exit_code: Option<i32>, stdout: &[u8], stderr: &[u8], expected_target_path: &str) -> C35RunnerOutputCheck {
    let mut stage = "process";
    let mut reason_code: Option<String> = None;
    let mut report: Option<serde_json::Value> = None;
    if exit_code.is_none() {
        reason_code = Some("C35_RUNNER_EXIT_CODE_UNAVAILABLE".to_string());
    } else if stdout.len() > C35_REPORT_MAX_BYTES {
        stage = "stdout_size";
        reason_code = Some("C35_RUNNER_STDOUT_TOO_LARGE".to_string());
    } else if stdout.iter().all(u8::is_ascii_whitespace) {
        stage = "stdout_empty";
        reason_code = Some("C35_RUNNER_STDOUT_EMPTY".to_string());
    } else if std::str::from_utf8(stdout).is_err() {
        stage = "stdout_utf8";
        reason_code = Some("C35_RUNNER_STDOUT_INVALID_UTF8".to_string());
    } else {
        let first = stdout.iter().copied().find(|byte| !byte.is_ascii_whitespace());
        let mut deserializer = serde_json::Deserializer::from_slice(stdout);
        match serde_json::Value::deserialize(&mut deserializer) {
            Err(_) => {
                stage = "json_parse";
                let valid_json_prefix = matches!(first, Some(b'{') | Some(b'[') | Some(b'"') | Some(b't') | Some(b'f') | Some(b'n') | Some(b'-') | Some(b'0'..=b'9'));
                reason_code = Some(if valid_json_prefix { "C35_RUNNER_STDOUT_INVALID_JSON" } else { "C35_RUNNER_STDOUT_PREFIX_POLLUTION" }.to_string());
            }
            Ok(parsed) => {
                report = Some(parsed);
                if deserializer.end().is_err() {
                    stage = "json_trailing_data";
                    reason_code = Some("C35_RUNNER_STDOUT_SUFFIX_POLLUTION".to_string());
                } else {
                    stage = "report_schema";
                    if let Some(parsed_report) = report.as_ref() {
                        if let Err(code) = c35_validate_runner_report(parsed_report, expected_target_path) {
                            reason_code = Some(code);
                        }
                    }
                }
            }
        }
    }
    if reason_code.is_none() {
        stage = "process_exit";
        let status = report.as_ref().and_then(|value| value.get("status")).and_then(serde_json::Value::as_str);
        match (exit_code, status) {
            (Some(0), Some("DRY_RUN_PASS")) => {}
            (Some(2), Some("DRY_RUN_BLOCKED")) => {}
            (Some(code), Some("DRY_RUN_PASS")) if code != 0 => reason_code = Some("C35_RUNNER_EXIT_NONZERO".to_string()),
            (Some(0), Some("DRY_RUN_BLOCKED")) => reason_code = Some("C35_RUNNER_EXIT_STATUS_MISMATCH".to_string()),
            _ => reason_code = Some("C35_RUNNER_EXIT_STATUS_MISMATCH".to_string()),
        }
    }
    let reason_ref = reason_code.as_deref();
    let diagnostic = c35_runner_diagnostic_value(exit_code, stdout, stderr, stage, reason_ref, report.as_ref());
    C35RunnerOutputCheck { report, reason_code, diagnostic }
}

#[tauri::command]
fn issue_recovery_restore_approval(
    app: tauri::AppHandle,
    mut request: RecoveryApprovalIssueRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<ExplicitRestoreApproval, String> {
    if state.reconstruction_dry_run_only {
        return Err("C35_RECONSTRUCTION_DRYRUN_ONLY".to_string());
    }
    let root = recovery_data_root()?;
    canonicalize_recovery_binding_domains(&mut request.plan)?;
    validate_recovery_approval_issue_request(&request, state.inner(), &root)?;
    validate_recovery_approval_slot(&request.plan)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "APPROVAL_WINDOW_INVALID".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|_| "APPROVAL_WINDOW_INVALID".to_string())?;
    confirm_native_restore_approval(hwnd.0, &request.plan)?;
    issue_recovery_approval_inner(request, state.inner(), &root)
}

#[tauri::command]
fn open_recovery_apply_window(
    request: RecoveryApplyWindowRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<serde_json::Value, String> {
    if state.reconstruction_dry_run_only {
        return Err("C35_RECONSTRUCTION_DRYRUN_ONLY".to_string());
    }
    /* Only the explicit RecoveryOnly handler exposes this volatile,
    plan-bound process window. It writes no state when it opens. */
    if request.plan.target_identity != state.target_identity
        || request.plan.target_origin != state.target_origin
    {
        return Err("RECOVERY_APPLY_WINDOW_TARGET_MISMATCH".to_string());
    }
    let data_root = recovery_data_root()?;
    open_recovery_apply_window_inner(request.approval, request.plan, state.inner(), &data_root)
}

#[tauri::command]
fn close_recovery_apply_window(
    request: RecoveryApplyWindowCloseRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<serde_json::Value, String> {
    close_recovery_apply_window_inner(request, state.inner())
}

#[tauri::command]
fn write_recovery_checkpoint(
    request: RecoveryCheckpointWriteRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<serde_json::Value, String> {
    if state.reconstruction_dry_run_only {
        return Err("C35_RECONSTRUCTION_DRYRUN_ONLY".to_string());
    }
    let root = recovery_data_root()?;
    write_recovery_checkpoint_inner(request.checkpoint, request.approval, state.inner(), &root)
}

#[tauri::command]
fn abort_recovery_checkpoint_before_apply(
    request: RecoveryCheckpointAbortRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<serde_json::Value, String> {
    if state.reconstruction_dry_run_only {
        return Err("C35_RECONSTRUCTION_DRYRUN_ONLY".to_string());
    }
    let root = recovery_data_root()?;
    abort_recovery_checkpoint_before_apply_inner(
        request.approval,
        request.plan,
        state.inner(),
        &root,
    )
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCheckpointVerifiedMarker {
    schema: String,
    version: u8,
    plan_id: String,
    verified_at: String,
}

#[tauri::command]
fn mark_recovery_checkpoint_verified(
    request: RecoveryPlanRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<serde_json::Value, String> {
    if state.reconstruction_dry_run_only {
        return Err("C35_RECONSTRUCTION_DRYRUN_ONLY".to_string());
    }
    if !PRODUCTION_RESTORE_ENABLED && !recovery_apply_window_matches(&request.plan_id, None, None) {
        return Err("PRODUCTION_RESTORE_DISABLED".to_string());
    }
    let root = recovery_data_root()?;
    let bytes = fs::read(checkpoint_path(&root))
        .map_err(|_| "RECOVERY_CHECKPOINT_NOT_FOUND".to_string())?;
    let checkpoint: RecoveryCheckpoint =
        serde_json::from_slice(&bytes).map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    validate_checkpoint_lifecycle_files(&root, &checkpoint, &bytes, true)?;
    if checkpoint.target_identity != state.target_identity
        || checkpoint.target_origin != state.target_origin
    {
        return Err("RECOVERY_CHECKPOINT_TARGET_MISMATCH".to_string());
    }
    if checkpoint.plan_id != request.plan_id {
        return Err("RECOVERY_CHECKPOINT_PLAN_MISMATCH".to_string());
    }
    let marker = RecoveryCheckpointVerifiedMarker {
        schema: "internalbeyond.recovery-checkpoint-verified".to_string(),
        version: 1,
        plan_id: request.plan_id,
        verified_at: chrono_free_timestamp(),
    };
    write_new_json(&verified_marker_path(&root), &marker)?;
    Ok(serde_json::json!({"ok":true,"planId":marker.plan_id}))
}

#[tauri::command]
fn clear_recovery_checkpoint_after_rollback(
    request: RecoveryRollbackClearRequest,
    state: tauri::State<'_, RecoveryOnlyHostState>,
) -> Result<serde_json::Value, String> {
    if state.reconstruction_dry_run_only {
        return Err("C35_RECONSTRUCTION_DRYRUN_ONLY".to_string());
    }
    if !PRODUCTION_RESTORE_ENABLED && !recovery_apply_window_matches(&request.plan_id, None, None) {
        return Err("PRODUCTION_RESTORE_DISABLED".to_string());
    }
    if !request.rollback_verified {
        return Err("RECOVERY_ROLLBACK_NOT_VERIFIED".to_string());
    }
    let root = recovery_data_root()?;
    let checkpoint_file = checkpoint_path(&root);
    let bytes =
        fs::read(&checkpoint_file).map_err(|_| "RECOVERY_CHECKPOINT_NOT_FOUND".to_string())?;
    let checkpoint: RecoveryCheckpoint =
        serde_json::from_slice(&bytes).map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    validate_checkpoint_lifecycle_files(&root, &checkpoint, &bytes, true)?;
    if checkpoint.target_identity != state.target_identity
        || checkpoint.target_origin != state.target_origin
    {
        return Err("RECOVERY_CHECKPOINT_TARGET_MISMATCH".to_string());
    }
    if checkpoint.plan_id != request.plan_id {
        return Err("RECOVERY_CHECKPOINT_PLAN_MISMATCH".to_string());
    }
    let verified_path = verified_marker_path(&root);
    if verified_path.exists() {
        let verified_bytes = fs::read(&verified_path)
            .map_err(|_| "RECOVERY_CHECKPOINT_CLEAR_MARKER_INVALID".to_string())?;
        let verified: RecoveryCheckpointVerifiedMarker = serde_json::from_slice(&verified_bytes)
            .map_err(|_| "RECOVERY_CHECKPOINT_CLEAR_MARKER_INVALID".to_string())?;
        if verified.schema != "internalbeyond.recovery-checkpoint-verified"
            || verified.version != 1
            || verified.plan_id != request.plan_id
        {
            return Err("RECOVERY_CHECKPOINT_CLEAR_FOREIGN_MARKER".to_string());
        }
    }
    let consumed_path = consumed_marker_path(&root);
    if consumed_path.exists() {
        let consumed_bytes = fs::read(&consumed_path)
            .map_err(|_| "RECOVERY_CHECKPOINT_CLEAR_MARKER_INVALID".to_string())?;
        let consumed: RecoveryFirstBootConsumed = serde_json::from_slice(&consumed_bytes)
            .map_err(|_| "RECOVERY_CHECKPOINT_CLEAR_MARKER_INVALID".to_string())?;
        if consumed.schema != RECOVERY_CONSUMED_SCHEMA
            || consumed.version != 1
            || consumed.plan_id != request.plan_id
        {
            return Err("RECOVERY_CHECKPOINT_CLEAR_FOREIGN_MARKER".to_string());
        }
    }
    cleanup_owned_recovery_checkpoint_lifecycle(
        &root,
        &checkpoint.lifecycle_id,
        &approval_binding_from_checkpoint(&checkpoint)?,
    )?;
    if verified_path.exists() {
        fs::remove_file(&verified_path)
            .map_err(|_| "RECOVERY_CHECKPOINT_CLEAR_FAILED".to_string())?;
    }
    if consumed_path.exists() {
        fs::remove_file(&consumed_path)
            .map_err(|_| "RECOVERY_CHECKPOINT_CLEAR_FAILED".to_string())?;
    }
    Ok(serde_json::json!({"ok":true,"planId":request.plan_id,"rolledBack":true}))
}

#[tauri::command]
fn acknowledge_recovery_first_boot(
    state: tauri::State<'_, Arc<HostLifecycle>>,
    plan_id: String,
) -> Result<serde_json::Value, String> {
    if !state.recovery_first_boot_pending.load(Ordering::Acquire) {
        return Ok(
            serde_json::json!({"ok":true,"skipped":true,"activeQuarantined":state.recovery_policy.active_quarantined()}),
        );
    }
    let expected = state
        .recovery_policy
        .plan_id
        .as_deref()
        .ok_or_else(|| "RECOVERY_BOOT_PLAN_MISSING".to_string())?;
    if expected != plan_id {
        return Err("RECOVERY_BOOT_PLAN_MISMATCH".to_string());
    }
    let root = state
        .recovery_data_root
        .as_ref()
        .ok_or_else(|| "RECOVERY_DATA_ROOT_UNAVAILABLE".to_string())?;
    let checkpoint_bytes =
        fs::read(checkpoint_path(root)).map_err(|_| "RECOVERY_CHECKPOINT_NOT_FOUND".to_string())?;
    let checkpoint: RecoveryCheckpoint = serde_json::from_slice(&checkpoint_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    validate_checkpoint_lifecycle_files(root, &checkpoint, &checkpoint_bytes, true)?;
    if checkpoint.plan_id != plan_id {
        return Err("RECOVERY_BOOT_PLAN_MISMATCH".to_string());
    }
    let consumed = RecoveryFirstBootConsumed {
        schema: RECOVERY_CONSUMED_SCHEMA.to_string(),
        version: 1,
        plan_id: plan_id.clone(),
        consumed_at: chrono_free_timestamp(),
    };
    let marker_path = consumed_marker_path(root);
    if marker_path.exists() {
        let existing_bytes =
            fs::read(&marker_path).map_err(|_| "RECOVERY_BOOT_MARKER_INVALID".to_string())?;
        let existing: RecoveryFirstBootConsumed = serde_json::from_slice(&existing_bytes)
            .map_err(|_| "RECOVERY_BOOT_MARKER_INVALID".to_string())?;
        if existing.schema == RECOVERY_CONSUMED_SCHEMA
            && existing.version == 1
            && existing.plan_id == plan_id
        {
            state
                .recovery_first_boot_pending
                .store(false, Ordering::Release);
            return Ok(
                serde_json::json!({"ok":true,"alreadyConsumed":true,"activeQuarantined":true}),
            );
        }
        return Err("RECOVERY_BOOT_MARKER_INVALID".to_string());
    }
    write_new_json(&marker_path, &consumed)?;
    state
        .recovery_first_boot_pending
        .store(false, Ordering::Release);
    Ok(serde_json::json!({"ok":true,"firstBootConsumed":true,"activeQuarantined":true}))
}

/* Recovery Finalize Authority (R3-E finalize).
   Preconditions: checkpoint integrity + lifecycle files, verified marker,
   credential-ready digest, no open apply window, plan binding match. On success
   it writes recovery-finalized.json so recovery_boot_policy_from_dir resolves
   Normal on the next start. It never spawns a service, never deletes the
   checkpoint, and never touches ACTIVE_REARM_ENABLED. */
#[tauri::command]
fn finalize_recovery(
    request: RecoveryFinalizeRequest,
    state: tauri::State<'_, Arc<HostLifecycle>>,
) -> Result<serde_json::Value, String> {
    if request.confirmation != RECOVERY_FINALIZE_PHRASE {
        return Err("RECOVERY_FINALIZE_CONFIRMATION_REQUIRED".to_string());
    }
    let root = state
        .recovery_data_root
        .as_ref()
        .ok_or_else(|| "RECOVERY_DATA_ROOT_UNAVAILABLE".to_string())?;
    let checkpoint_bytes = fs::read(checkpoint_path(root))
        .map_err(|_| "RECOVERY_CHECKPOINT_NOT_FOUND".to_string())?;
    let checkpoint: RecoveryCheckpoint = serde_json::from_slice(&checkpoint_bytes)
        .map_err(|_| "RECOVERY_CHECKPOINT_INVALID".to_string())?;
    validate_recovery_checkpoint(&checkpoint)?;
    validate_checkpoint_lifecycle_files(root, &checkpoint, &checkpoint_bytes, true)?;
    if checkpoint.plan_id != request.plan_id {
        return Err("RECOVERY_FINALIZE_PLAN_MISMATCH".to_string());
    }
    let verified_bytes = fs::read(verified_marker_path(root))
        .map_err(|_| "RECOVERY_FINALIZE_VERIFIED_MARKER_MISSING".to_string())?;
    let verified: RecoveryCheckpointVerifiedMarker = serde_json::from_slice(&verified_bytes)
        .map_err(|_| "RECOVERY_FINALIZE_VERIFIED_MARKER_INVALID".to_string())?;
    if verified.schema != "internalbeyond.recovery-checkpoint-verified"
        || verified.version != 1
        || verified.plan_id != checkpoint.plan_id
        || verified.verified_at.is_empty()
    {
        return Err("RECOVERY_FINALIZE_VERIFIED_MARKER_INVALID".to_string());
    }
    if recovery_apply_window_matches(&checkpoint.plan_id, None, None) {
        return Err("RECOVERY_FINALIZE_APPLY_WINDOW_OPEN".to_string());
    }
    let credential_ready_digest = request.credential_ready_digest.to_lowercase();
    if !is_sha256(&credential_ready_digest) {
        return Err("RECOVERY_FINALIZE_CREDENTIAL_DIGEST_INVALID".to_string());
    }
    let checkpoint_file_sha256 = sha256_hex(&checkpoint_bytes);
    if finalized_marker_path(root).exists() {
        if read_finalized_marker_valid_for(
            root,
            &checkpoint.plan_id,
            &checkpoint.lifecycle_id,
            &checkpoint_file_sha256,
        )
        .is_some()
        {
            let policy = recovery_boot_policy_from_dir(root);
            return Ok(serde_json::json!({
                "ok": true,
                "alreadyFinalized": true,
                "planId": checkpoint.plan_id,
                "bootMode": recovery_boot_mode_name(policy.mode)
            }));
        }
        return Err("RECOVERY_FINALIZE_MARKER_FOREIGN".to_string());
    }
    let marker = RecoveryFinalizedMarker {
        schema: RECOVERY_FINALIZED_SCHEMA.to_string(),
        version: 1,
        plan_id: checkpoint.plan_id.clone(),
        lifecycle_id: checkpoint.lifecycle_id.clone(),
        checkpoint_file_sha256,
        verified_at: verified.verified_at.clone(),
        credential_ready_digest,
        authorized_at: chrono_free_timestamp(),
    };
    write_new_json(&finalized_marker_path(root), &marker)?;
    let policy = recovery_boot_policy_from_dir(root);
    Ok(serde_json::json!({
        "ok": true,
        "finalized": true,
        "planId": marker.plan_id,
        "bootMode": recovery_boot_mode_name(policy.mode)
    }))
}

fn chrono_free_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatusBinding {
    binding_id: String,
    #[serde(default)]
    capability: Option<String>,
    #[serde(default)]
    credential_policy: Option<String>,
    #[serde(default)]
    endpoint_class: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CredentialStatusRequest {
    bindings: Vec<CredentialStatusBinding>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialResolveRequest {
    binding_id: String,
}

fn credential_status_error(code: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "errorCode": code,
        "results": []
    })
}

fn credential_status_binding_id_allowed(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn credential_status_projection_safe(value: &serde_json::Value) -> bool {
    const ALLOWED: &[&str] = &[
        "ok",
        "results",
        "errorCode",
        "credentialRef",
        "authorityScope",
        "status",
        "secretPresent",
        "sourceClass",
        "bindingId",
    ];
    match value {
        serde_json::Value::Object(map) => map.iter().all(|(key, child)| {
            ALLOWED.contains(&key.as_str()) && credential_status_projection_safe(child)
        }),
        serde_json::Value::Array(items) => items.iter().all(credential_status_projection_safe),
        _ => true,
    }
}

#[tauri::command(rename_all = "camelCase")]
fn credential_status(
    state: tauri::State<'_, Arc<HostLifecycle>>,
    request: CredentialStatusRequest,
) -> serde_json::Value {
    if request.bindings.len() > 200
        || request
            .bindings
            .iter()
            .any(|binding| !credential_status_binding_id_allowed(&binding.binding_id))
    {
        return credential_status_error("CREDENTIAL_STATUS_REQUEST_INVALID");
    }

    let root = state.inner().root.clone();
    let script = root
        .join("active")
        .join("credential-authority-adapter-cli.js");
    if !script.exists() {
        return credential_status_error("CREDENTIAL_STATUS_HOST_UNAVAILABLE");
    }
    let node = match launcher_node(&root) {
        Some(value) => value,
        None => return credential_status_error("CREDENTIAL_STATUS_HOST_UNAVAILABLE"),
    };
    let payload = match serde_json::to_vec(&request) {
        Ok(value) => value,
        Err(_) => return credential_status_error("CREDENTIAL_STATUS_REQUEST_INVALID"),
    };

    let mut command = Command::new(node);
    command
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hidden_command(&mut command);

    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(_) => return credential_status_error("CREDENTIAL_STATUS_HOST_UNAVAILABLE"),
    };
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(&payload).is_err() {
            return credential_status_error("CREDENTIAL_STATUS_HOST_UNAVAILABLE");
        }
    }
    let output = match child.wait_with_output() {
        Ok(value) => value,
        Err(_) => return credential_status_error("CREDENTIAL_STATUS_HOST_UNAVAILABLE"),
    };
    if output.stdout.len() > 128 * 1024 {
        return credential_status_error("CREDENTIAL_STATUS_RESPONSE_TOO_LARGE");
    }
    let value: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(_) => return credential_status_error("CREDENTIAL_STATUS_RESPONSE_INVALID"),
    };
    if !credential_status_projection_safe(&value) {
        return credential_status_error("CREDENTIAL_STATUS_PROJECTION_INVALID");
    }
    value
}

fn credential_resolve_unavailable() -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "errorCode": "CREDENTIAL_UNAVAILABLE"
    })
}

/* Resolve one allowlisted Vault binding for a single Web Core request. The
   secret travels only through this bounded child-process pipe and the
   request-scoped Tauri response; it is never logged or written by this Host. */
#[tauri::command(rename_all = "camelCase")]
fn credential_resolve(
    state: tauri::State<'_, Arc<HostLifecycle>>,
    request: CredentialResolveRequest,
) -> serde_json::Value {
    const MAX_SECRET_BYTES: usize = 8192;
    const MAX_RESPONSE_BYTES: usize = 16 * 1024;

    if !credential_status_binding_id_allowed(&request.binding_id) {
        return credential_resolve_unavailable();
    }

    let root = state.inner().root.clone();
    let script = root
        .join("active")
        .join("credential-resolver-cli.js");
    if !script.exists() {
        return credential_resolve_unavailable();
    }
    let node = match launcher_node(&root) {
        Some(value) => value,
        None => return credential_resolve_unavailable(),
    };
    let payload = match serde_json::to_vec(&request) {
        Ok(value) => value,
        Err(_) => return credential_resolve_unavailable(),
    };

    let mut command = Command::new(node);
    command
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hidden_command(&mut command);

    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(_) => return credential_resolve_unavailable(),
    };
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(&payload).is_err() {
            return credential_resolve_unavailable();
        }
    }
    let mut output = match child.wait_with_output() {
        Ok(value) => value,
        Err(_) => return credential_resolve_unavailable(),
    };
    if !output.status.success() || output.stdout.len() > MAX_RESPONSE_BYTES {
        output.stdout.fill(0);
        return credential_resolve_unavailable();
    }
    let mut value: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(_) => {
            output.stdout.fill(0);
            return credential_resolve_unavailable();
        }
    };
    output.stdout.fill(0);

    let object = match value.as_object_mut() {
        Some(object) if object.len() == 3 => object,
        _ => return credential_resolve_unavailable(),
    };
    if object.remove("ok").and_then(|v| v.as_bool()) != Some(true) || object.len() != 2 {
        return credential_resolve_unavailable();
    }
    let provider = match object.remove("provider") {
        Some(serde_json::Value::String(provider))
            if !provider.is_empty()
                && provider.len() <= 48
                && provider
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')) => provider,
        _ => return credential_resolve_unavailable(),
    };
    let secret_value = match object.remove("apiKey") {
        Some(serde_json::Value::String(secret))
            if !secret.trim().is_empty() && secret.len() <= MAX_SECRET_BYTES => secret,
        _ => return credential_resolve_unavailable(),
    };
    if !object.is_empty() {
        return credential_resolve_unavailable();
    }

    let mut response = serde_json::Map::new();
    response.insert("ok".to_string(), serde_json::Value::Bool(true));
    response.insert("provider".to_string(), serde_json::Value::String(provider));
    response.insert(
        "apiKey".to_string(),
        serde_json::Value::String(secret_value),
    );
    serde_json::Value::Object(response)
}

#[cfg(debug_assertions)]
fn development_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or(manifest_dir)
}

fn normalize_windows_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(stripped) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn runtime_mode() -> Result<RuntimeMode, String> {
    RuntimeMode::parse(
        std::env::var(RUNTIME_MODE_ENV).ok().as_deref(),
        cfg!(debug_assertions),
    )
}

fn required_runtime_files() -> &'static [&'static str] {
    &[
        "InternalBeyond.html",
        "VERSION",
        "runtime/node/node.exe",
        "runtime/launch-internal-beyond.js",
        "runtime/local-services-runner.js",
        "runtime/component-registry.js",
        "runtime/component-lifecycle.js",
        "runtime/service-control.js",
        "services/active-message-service.js",
        "services/ib-bridge-service.js",
        "services/home-node-service.js",
        "active/persistence.js",
    ]
}

fn has_runtime_payload(root: &Path) -> bool {
    required_runtime_files()
        .iter()
        .all(|relative| root.join(relative).is_file())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_product_version(root: &Path) -> Result<String, String> {
    let version = fs::read_to_string(root.join("VERSION"))
        .map_err(|_| "RUNTIME_PAYLOAD_INVALID: VERSION is unreadable".to_string())?
        .trim()
        .to_string();
    if version.is_empty()
        || !version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    {
        return Err("RUNTIME_PAYLOAD_INVALID: VERSION is malformed".to_string());
    }
    Ok(version)
}

fn production_payload_identity(root: &Path) -> Result<(String, u64, String), String> {
    if !root.join(PAYLOAD_MANIFEST).is_file() {
        return Err("RUNTIME_PAYLOAD_INVALID: production payload manifest is missing".to_string());
    }
    if !root.join("internalbeyond-host.exe").is_file() {
        return Err("RUNTIME_PAYLOAD_INVALID: production Host is missing".to_string());
    }
    if !has_runtime_payload(root) {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: required production payload file is missing".to_string(),
        );
    }

    let raw = fs::read(root.join(PAYLOAD_MANIFEST)).map_err(|_| {
        "RUNTIME_PAYLOAD_INVALID: production payload manifest is unreadable".to_string()
    })?;
    let manifest: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| {
        "RUNTIME_PAYLOAD_INVALID: production payload manifest is malformed".to_string()
    })?;
    if manifest.get("schema").and_then(serde_json::Value::as_str)
        != Some("internalbeyond.payload-manifest")
    {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: production payload manifest schema mismatch".to_string(),
        );
    }
    let manifest_version = manifest
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            "RUNTIME_PAYLOAD_INVALID: production payload manifest version missing".to_string()
        })?;
    if manifest_version != 1 {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: unsupported production payload manifest version".to_string(),
        );
    }

    let product_version = read_product_version(root)?;
    if manifest.get("product").and_then(serde_json::Value::as_str) != Some(product_version.as_str())
    {
        return Err("RUNTIME_PAYLOAD_INVALID: payload product version mismatch".to_string());
    }
    if product_version != env!("CARGO_PKG_VERSION") {
        return Err("RUNTIME_PAYLOAD_INVALID: Host/package version mismatch".to_string());
    }

    let files = manifest
        .get("files")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "RUNTIME_PAYLOAD_INVALID: payload manifest file list missing".to_string())?;
    let declared: BTreeSet<String> = files
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(|value| value.replace('\\', "/"))
        .collect();
    if declared.len() != files.len()
        || manifest.get("count").and_then(serde_json::Value::as_u64) != Some(files.len() as u64)
    {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: payload manifest file count is inconsistent".to_string(),
        );
    }
    for required in [
        PAYLOAD_MANIFEST,
        "internalbeyond-host.exe",
        "InternalBeyond.html",
        "VERSION",
        "runtime/node/node.exe",
        "runtime/launch-internal-beyond.js",
        "runtime/local-services-runner.js",
        "services/active-message-service.js",
        "services/ib-bridge-service.js",
        "services/home-node-service.js",
        "active/persistence.js",
        "tools/ib-stop.js",
        "启动 InternalBeyond.vbs",
    ] {
        if !declared.contains(required) {
            return Err(format!(
                "RUNTIME_PAYLOAD_INVALID: required file is absent from payload manifest: {required}"
            ));
        }
    }

    Ok((product_version, manifest_version, sha256_hex(&raw)))
}

fn recovery_payload_content_identity(
    root: &Path,
    declared: &BTreeSet<String>,
) -> Result<String, String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| "RUNTIME_PAYLOAD_INVALID: recovery target root is unavailable".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(b"internalbeyond.recovery-target-content-identity.v1\0");
    hasher.update((declared.len() as u64).to_be_bytes());
    for relative in declared {
        let relative_path = Path::new(relative);
        if relative_path.as_os_str().is_empty()
            || relative_path
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(
                "RUNTIME_PAYLOAD_INVALID: recovery manifest path is not root-relative".to_string(),
            );
        }
        let candidate = root.join(relative_path);
        let canonical_file = fs::canonicalize(&candidate)
            .map_err(|_| "RUNTIME_PAYLOAD_INVALID: recovery payload file is missing".to_string())?;
        if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
            return Err(
                "RUNTIME_PAYLOAD_INVALID: recovery payload path escapes canonical root".to_string(),
            );
        }
        let bytes = fs::read(&canonical_file).map_err(|_| {
            "RUNTIME_PAYLOAD_INVALID: recovery payload file is unreadable".to_string()
        })?;
        hasher.update((relative.len() as u64).to_be_bytes());
        hasher.update(relative.as_bytes());
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(&bytes);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn recovery_payload_content_identity_from_manifest(root: &Path) -> Result<String, String> {
    let raw = fs::read(root.join(PAYLOAD_MANIFEST)).map_err(|_| {
        "RUNTIME_PAYLOAD_INVALID: recovery payload manifest is unreadable".to_string()
    })?;
    let manifest: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| {
        "RUNTIME_PAYLOAD_INVALID: recovery payload manifest is malformed".to_string()
    })?;
    let files = manifest
        .get("files")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "RUNTIME_PAYLOAD_INVALID: recovery payload manifest file list missing".to_string()
        })?;
    let declared: BTreeSet<String> = files
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(|value| value.replace('\\', "/"))
        .collect();
    if declared.len() != files.len()
        || manifest.get("count").and_then(serde_json::Value::as_u64) != Some(files.len() as u64)
    {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: recovery payload manifest count is inconsistent".to_string(),
        );
    }
    recovery_payload_content_identity(root, &declared)
}

fn acceptance_resolution(root: PathBuf) -> Result<RuntimeResolution, String> {
    if !has_runtime_payload(&root) {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: acceptance resource payload is incomplete".to_string(),
        );
    }
    Ok(RuntimeResolution {
        product_version: read_product_version(&root).unwrap_or_default(),
        root,
        mode: RuntimeMode::Acceptance,
        root_class: RuntimeMode::Acceptance.root_class(),
        payload_manifest_version: None,
        payload_identity: None,
    })
}

fn development_resolution(root: PathBuf) -> Result<RuntimeResolution, String> {
    if !has_runtime_payload(&root) {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: development workspace payload is incomplete".to_string(),
        );
    }
    Ok(RuntimeResolution {
        product_version: read_product_version(&root).unwrap_or_default(),
        root,
        mode: RuntimeMode::Development,
        root_class: RuntimeMode::Development.root_class(),
        payload_manifest_version: None,
        payload_identity: None,
    })
}

fn resolve_runtime_root(app: &tauri::AppHandle) -> Result<RuntimeResolution, String> {
    let mode = runtime_mode()?;
    if mode != RuntimeMode::Development && std::env::var_os("IB_PROJECT_ROOT").is_some() {
        return Err(
            "RUNTIME_PAYLOAD_INVALID: IB_PROJECT_ROOT is only allowed in development mode"
                .to_string(),
        );
    }

    let resource_dir = app.path().resource_dir().map_err(|_| {
        "RUNTIME_PAYLOAD_INVALID: Tauri resource directory is unavailable".to_string()
    })?;
    let exe_dir = app
        .path()
        .executable_dir()
        .unwrap_or_else(|_| resource_dir.clone());
    let process_exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| exe_dir.clone());

    match mode {
        RuntimeMode::Development => {
            #[cfg(debug_assertions)]
            {
                let root = std::env::var("IB_PROJECT_ROOT")
                    .ok()
                    .map(PathBuf::from)
                    .unwrap_or_else(development_root);
                return development_resolution(normalize_windows_path(root));
            }
            #[cfg(not(debug_assertions))]
            {
                let _ = (resource_dir, exe_dir, process_exe_dir);
                Err(
                    "RUNTIME_MODE_INVALID: development mode is unavailable in a release Host"
                        .to_string(),
                )
            }
        }
        RuntimeMode::Acceptance => {
            if let Ok(value) = std::env::var(ACCEPTANCE_ROOT_ENV) {
                return acceptance_resolution(normalize_windows_path(PathBuf::from(value)));
            }
            let candidates = [
                resource_dir.clone(),
                resource_dir.join("_up_"),
                exe_dir.join("_up_"),
                process_exe_dir.join("_up_"),
            ];
            candidates
                .into_iter()
                .map(normalize_windows_path)
                .find_map(|candidate| acceptance_resolution(candidate).ok())
                .ok_or_else(|| {
                    "RUNTIME_PAYLOAD_INVALID: acceptance resource root is unavailable".to_string()
                })
        }
        RuntimeMode::Production => {
            let candidates = [process_exe_dir, exe_dir];
            for candidate in candidates {
                let candidate = normalize_windows_path(candidate);
                if !candidate.join(PAYLOAD_MANIFEST).is_file() {
                    continue;
                }
                let (product_version, manifest_version, payload_identity) =
                    production_payload_identity(&candidate)?;
                return Ok(RuntimeResolution {
                    root: candidate,
                    mode,
                    root_class: mode.root_class(),
                    product_version,
                    payload_manifest_version: Some(manifest_version),
                    payload_identity: Some(payload_identity),
                });
            }
            Err(
                "RUNTIME_PAYLOAD_INVALID: canonical Inno payload identity is unavailable"
                    .to_string(),
            )
        }
    }
}

fn launcher_node(root: &PathBuf) -> Option<PathBuf> {
    if let Ok(value) = std::env::var("IB_NODE") {
        let candidate = PathBuf::from(value);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let bundled = root.join("runtime").join("node").join("node.exe");
    if bundled.exists() {
        return Some(bundled);
    }
    None
}

fn hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn inspect_launcher_result(state: &HostLifecycle) {
    let raw = match std::fs::read_to_string(&state.boot_state) {
        Ok(value) => value,
        Err(_) => return,
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return,
    };
    let started = value
        .get("launcher")
        .and_then(|launcher| launcher.get("serviceManager"))
        .and_then(|manager| manager.get("started"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    state.runner_owned.store(started, Ordering::Release);
}

fn launcher_candidates(state: &HostLifecycle) -> Vec<PathBuf> {
    vec![state.root.clone()]
}

fn launcher_root(state: &HostLifecycle) -> Option<PathBuf> {
    let launcher = state.root.join("runtime").join("launch-internal-beyond.js");
    launcher.is_file().then(|| state.root.clone())
}

fn write_bootstrap_trace(state: &HostLifecycle, candidates: &[PathBuf]) {
    if std::env::var("IB_TAURI_DEBUG").ok().as_deref() != Some("1") {
        return;
    }
    let rows = candidates
        .iter()
        .map(|candidate| {
            serde_json::json!({
                "candidate": candidate,
                "launcher": candidate.join("runtime").join("launch-internal-beyond.js"),
                "exists": candidate.join("runtime").join("launch-internal-beyond.js").exists(),
                "ui": candidate.join("InternalBeyond.html").exists(),
                "docs": candidate.join("docs").exists(),
            })
        })
        .collect::<Vec<_>>();
    let trace = serde_json::json!({
        "stateRoot": state.root,
        "bootState": state.boot_state,
        "currentExe": std::env::current_exe().ok(),
        "candidates": rows,
    });
    if let Some(parent) = state.boot_state.parent() {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(
            parent.join("host-bootstrap-trace.json"),
            serde_json::to_vec_pretty(&trace).unwrap_or_default(),
        );
    }
}

fn spawn_existing_launcher(state: &Arc<HostLifecycle>) {
    let candidates = launcher_candidates(state);
    write_bootstrap_trace(state, &candidates);
    let root = match launcher_root(state) {
        Some(root) => root,
        None => {
            /* A source checkout without the bundled runtime can still open the
            Tauri host; diagnostics will show the existing sidecars as degraded. */
            return;
        }
    };
    let launcher = root.join("runtime").join("launch-internal-beyond.js");
    if !launcher.exists() {
        return;
    }

    let node = match launcher_node(&root) {
        Some(node) => node,
        None => {
            /* A packaged production Host must never fall back to PATH Node;
            the canonical Inno payload owns the bundled runtime. */
            return;
        }
    };
    let mut command = Command::new(node);
    command
        .arg(&launcher)
        .current_dir(&root)
        .env("IB_LAUNCH_NO_OPEN", "1")
        .env("IB_TAURI_HOST", "1")
        .env(RUNTIME_MODE_ENV, state.runtime.mode.as_str())
        .env(RUNTIME_ROOT_CLASS_ENV, state.runtime.root_class)
        .env("IB_RUNTIME_PRODUCT_VERSION", &state.runtime.product_version)
        .env(
            "IB_RUNTIME_PAYLOAD_MANIFEST_VERSION",
            state
                .runtime
                .payload_manifest_version
                .map(|value| value.to_string())
                .unwrap_or_default(),
        )
        .env(
            "IB_RUNTIME_PAYLOAD_IDENTITY",
            state
                .runtime
                .payload_identity
                .as_deref()
                .unwrap_or_default(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() == Some("1") {
        command.env("IB_ACCEPTANCE_SECRET_ROUTES", "1");
        if let Some(run_id) = acceptance_run_id() {
            command.env("IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID", run_id);
        }
    }
    hidden_command(&mut command);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return,
    };
    state.launcher_pid.store(child.id(), Ordering::Release);
    state.launcher_done.store(false, Ordering::Release);
    let monitor = Arc::clone(state);
    thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        inspect_launcher_result(&monitor);
        monitor.launcher_pid.store(0, Ordering::Release);
        monitor.launcher_done.store(true, Ordering::Release);
    });
}

fn terminate_exact_launcher(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill.exe");
        command
            .args(["/PID", &pid.to_string(), "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hidden_command(&mut command);
        let _ = command.status();
    }

    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn restart_port() -> u16 {
    std::env::var("IB_RESTART_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_RESTART_PORT)
}

fn request_runner_shutdown(port: u16) {
    let address = format!("127.0.0.1:{port}");
    let mut stream = match std::net::TcpStream::connect_timeout(
        &address.parse().unwrap(),
        Duration::from_millis(900),
    ) {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let request = format!(
        "POST /shutdown HTTP/1.1\r\nHost: {address}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(request.as_bytes());
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let mut response = [0_u8; 256];
    let _ = stream.read(&mut response);
}

fn stop_host_owned_services(state: &HostLifecycle) {
    if state.shutdown_requested.swap(true, Ordering::AcqRel) {
        return;
    }

    /* Give the existing launcher a short bounded window to write its final
    boot-state. We never kill a generic node.exe; the only possible kill is
    the exact launcher child created above, and normal close usually reaches
    this point after it has exited. */
    let deadline = Instant::now() + Duration::from_secs(3);
    while !state.launcher_done.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if state.runner_owned.load(Ordering::Acquire) {
        request_runner_shutdown(restart_port());
    }

    /* If the host is closed while the launcher is still waiting, terminate only
    the exact child process this host spawned. Its runner ownership was not
    proven in that case, so no service shutdown is attempted. */
    if !state.launcher_done.load(Ordering::Acquire) {
        terminate_exact_launcher(state.launcher_pid.load(Ordering::Acquire));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let entry_mode = host_entry_mode(std::env::args_os().skip(1));
    let recovery_only = !host_starts_normal_services(entry_mode);
    let process_args = std::env::args().skip(1).collect::<Vec<_>>();
    let c35_dry_run_requested = host_requests_c35_dry_run(&process_args);
    let recovery_policy = if matches!(runtime_mode(), Ok(RuntimeMode::Production)) {
        current_recovery_boot_policy().0
    } else {
        RecoveryBootPolicy::normal()
    };
    let restricted_recovery_page = recovery_only || recovery_policy.blocked();
    let suppress_page_load_side_effects =
        restricted_recovery_page || recovery_policy.suppress_services();
    let mut builder = tauri::Builder::default();
    let acceptance_document_seq = Arc::new(AtomicU32::new(0));
    let document_seq_for_events = Arc::clone(&acceptance_document_seq);
    builder = builder.on_page_load(move |webview, payload| {
        /* RecoveryOnly pages do not receive normal-host markers, acceptance
        probes, or any page-load side effects. */
        if suppress_page_load_side_effects {
            return;
        }
        let page_url = payload.url();
        let url_class =
            acceptance_url_class(page_url.scheme(), page_url.host_str(), page_url.path());
        let document_seq = match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                document_seq_for_events.fetch_add(1, Ordering::AcqRel) + 1
            }
            tauri::webview::PageLoadEvent::Finished => {
                let current = document_seq_for_events.load(Ordering::Acquire);
                if current == 0 {
                    document_seq_for_events.fetch_add(1, Ordering::AcqRel) + 1
                } else {
                    current
                }
            }
        };
        if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() == Some("1") {
            let phase = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "STARTED",
                tauri::webview::PageLoadEvent::Finished => "FINISHED",
            };
            acceptance_transport_log(&format!(
                "M1B_PAGE_{}_DOC{}_CLASS_{}_SCHEME_{}",
                phase,
                document_seq,
                url_class,
                acceptance_scheme_class(page_url.scheme())
            ));
        }
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            return;
        }
        if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() == Some("1") {
            acceptance_transport_log("M1B_PAGE_LOAD_CALLBACK");
            match url_class {
                "INTERNALBEYOND" => acceptance_transport_log("M1B_PAGE_URL_INTERNAL"),
                "BLANK" => acceptance_transport_log("M1B_PAGE_URL_BLANK"),
                _ => acceptance_transport_log("M1B_PAGE_URL_OTHER"),
            }
        }

        /* The packaged Host may use a WebView2 page origin that does not expose
        the global Tauri namespace. This fixed, input-free marker keeps
        IB.host surface detection truthful without adding IPC. */
        if webview.eval("window.__IB_TAURI_HOST__ = true;").is_err() {
            acceptance_transport_log("M1B_MARKER_EVAL_FAILED");
        } else if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() == Some("1") {
            acceptance_transport_log("M1B_MARKER_EVAL_OK");
        }

        if url_class != "INTERNALBEYOND"
            || std::env::var("IB_ACCEPTANCE_SECRET_ROUTES").ok().as_deref() != Some("1")
        {
            return;
        }
        if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES_MODE")
            .ok()
            .as_deref()
            != Some("transport")
        {
            acceptance_transport_log("M0_GATE_DETECTED");
            acceptance_transport_log("M1_PROBE_REGISTERED");
        }
        let Some(probe) = acceptance_document_probe(document_seq, url_class) else {
            acceptance_transport_log("M1B_DOCUMENT_PROBE_NOT_REGISTERED");
            return;
        };
        acceptance_transport_log(&format!(
            "M1B_DOCUMENT_PROBE_SCHEDULED_DOC{}_CLASS_{}",
            document_seq, url_class
        ));
        let main_webview = webview.clone();
        let eval_webview = main_webview.clone();
        let document_seq_for_thread = Arc::clone(&document_seq_for_events);
        thread::spawn(move || {
            if !wait_for_acceptance_endpoint() {
                acceptance_transport_log(&format!(
                    "M1B_DOCUMENT_PROBE_ENDPOINT_TIMEOUT_DOC{}",
                    document_seq
                ));
                return;
            }
            if document_seq_for_thread.load(Ordering::Acquire) != document_seq {
                acceptance_transport_log(&format!("M1B_DOCUMENT_PROBE_STALE_DOC{}", document_seq));
                return;
            }
            let result = main_webview.run_on_main_thread(move || {
                if eval_webview.eval(&probe).is_err() {
                    acceptance_transport_log(&format!(
                        "M1B_DOCUMENT_PROBE_EVAL_FAILED_DOC{}",
                        document_seq
                    ));
                    acceptance_transport_log("M1B_PROBE_EVAL_FAILED");
                } else {
                    acceptance_transport_log(&format!(
                        "M1B_DOCUMENT_PROBE_EXECUTED_DOC{}",
                        document_seq
                    ));
                    acceptance_transport_log("M1B_PROBE_EVAL_OK");
                }
            });
            if result.is_err() {
                acceptance_transport_log(&format!(
                    "M1B_DOCUMENT_PROBE_MAIN_THREAD_FAILED_DOC{}",
                    document_seq
                ));
            }
        });
    });

    #[cfg(desktop)]
    {
        /* Must be registered before other plugins so a second launch exits
        without creating a second WebView profile. A running normal Host ignores
        a later recovery-only invocation; a running RecoveryOnly Host never
        launches the normal service graph. */
        let recovery_only_instance = recovery_only;
        builder = builder.plugin(tauri_plugin_single_instance::init(
            move |app, args, _cwd| {
                if !recovery_only_instance && args_request_recovery_only(&args) {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ));
        if !restricted_recovery_page {
            builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
        }
    }

    let recovery_policy_for_setup = recovery_policy.clone();
    builder = builder.setup(move |app| {
            let runtime = resolve_runtime_root(app.handle())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            if restricted_recovery_page {
                if runtime.mode != RuntimeMode::Production {
                    return Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "RECOVERY_ONLY_REQUIRES_CANONICAL_PRODUCTION_ROOT",
                    )));
                }
                recovery_payload_is_complete(&runtime.root)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::NotFound, error))?;
                let target_payload_identity = if recovery_only {
                    recovery_payload_content_identity_from_manifest(&runtime.root)
                        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?
                } else {
                    runtime.payload_identity.clone().unwrap_or_default()
                };
                let target_identity = format!(
                    "com.internalbeyond.desktop|{}|{}|{}|{}",
                    runtime.root_class,
                    runtime.root.to_string_lossy(),
                    runtime.product_version,
                    target_payload_identity
                );
                if recovery_only {
                    app.manage(RecoveryOnlyHostState {
                        target_identity: target_identity.clone(),
                        target_origin: "http://tauri.localhost".to_string(),
                        active_quarantined: recovery_policy_for_setup.active_quarantined(),
                        reconstruction_dry_run_only: true,
                    });
                    app.manage(RecoveryOnlyLifecycle::default());
                }
                let target_identity_js = serde_json::to_string(&target_identity).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "recovery target identity serialization failed",
                    )
                })?;
                let recovery_init_script = format!(
                    "Object.defineProperty(window, '__IB_TAURI_HOST__', {{value:true,writable:false,configurable:false}}); Object.defineProperty(window, '__IB_RECOVERY_ONLY__', {{value:true,writable:false,configurable:false}}); Object.defineProperty(window, '__IB_C35_DRYRUN_ONLY__', {{value:true,writable:false,configurable:false}}); Object.defineProperty(window, '__IB_P32W5_C35_DRYRUN_REQUESTED__', {{value:{},writable:false,configurable:false}}); Object.defineProperty(window, '__IB_RECOVERY_BOOT_BLOCKED__', {{value:{},writable:false,configurable:false}}); Object.defineProperty(window, '__IB_RECOVERY_TARGET_IDENTITY__', {{value:{},writable:false,configurable:false}});",
                    c35_dry_run_requested,
                    recovery_policy_for_setup.blocked(),
                    target_identity_js
                );
                let window = tauri::WebviewWindowBuilder::new(
                    app.handle(),
                    "main",
                    tauri::WebviewUrl::App(PathBuf::from("Recovery.html")),
                )
                .title(if recovery_policy_for_setup.blocked() { "InternalBeyond Recovery Safe Mode" } else { "InternalBeyond Recovery" })
                .visible(true)
                .initialization_script(&recovery_init_script)
                .build()?;
                let _ = window.show();
                /* No ProjectKnowledge state, HostLifecycle, launcher, runner,
                   normal invoke handlers, or app services are installed here. */
                return Ok(());
            }
        let recovery_policy = recovery_policy_for_setup.clone();
        app.manage(ProjectKnowledgeState::new(runtime.root.clone()));

        #[cfg(desktop)]
        {
                let window_config = app
                    .config()
                    .app
                    .windows
                    .first()
                    .ok_or("missing main Tauri window configuration")?;
                let mut init_script = "window.__IB_TAURI_HOST__ = true;".to_string();
                if std::env::var("IB_ACCEPTANCE_SECRET_ROUTES_MODE")
                    .ok()
                    .as_deref()
                    == Some("transport")
                {
                    if let Some(probe) = acceptance_bootstrap_probe() {
                        init_script.push('\n');
                        init_script.push_str(&probe);
                        acceptance_transport_log("M1_INIT_PROBE_REGISTERED");
                    }
            }
            init_script.push('\n');
            init_script.push_str(&format!(
                "window.__IB_RECOVERY_FIRST_BOOT__ = {}; window.__IB_RECOVERY_ACTIVE_HOLD__ = {}; window.__IB_RECOVERY_BOOT_BLOCKED__ = {};",
                recovery_policy.first_boot_pending(),
                recovery_policy.active_quarantined(),
                recovery_policy.blocked()
            ));
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                .initialization_script(init_script)
                .build()?;
            let _ = window.show();
            let lifecycle = Arc::new(HostLifecycle::new(runtime, recovery_policy.clone()));
            app.manage(Arc::clone(&lifecycle));
            if !recovery_policy.suppress_services() {
                spawn_existing_launcher(&lifecycle);
            }
            }
            Ok(())
        });

    /* RecoveryOnly exposes the C3.5 read-only reconstruction dry-run plus
    lifecycle inspection. Restore approval/checkpoint/apply commands remain
    registered for compatibility but fail closed while the C3.5 host is in
    reconstruction-dry-run-only mode. Normal services remain unavailable. */
    let builder = if recovery_only {
        builder.invoke_handler(tauri::generate_handler![
            p32_w5_r3_c3_5_reconstruction_dry_run,
            p32_w5_r3_c3_5_child_process_boundary_probe,
            read_recovery_checkpoint,
            issue_recovery_restore_approval,
            open_recovery_apply_window,
            close_recovery_apply_window,
            write_recovery_checkpoint,
            abort_recovery_checkpoint_before_apply,
            mark_recovery_checkpoint_verified,
            clear_recovery_checkpoint_after_rollback
        ])
    } else if recovery_policy.blocked() {
        builder
    } else {
        builder.invoke_handler(tauri::generate_handler![
            list_project_docs,
            search_project_docs,
            read_project_doc,
            project_knowledge_status,
            credential_status,
            credential_resolve,
            acknowledge_recovery_first_boot,
            finalize_recovery,
        ])
    };

    builder
        .build(tauri::generate_context!())
        .expect("error while building InternalBeyond Tauri host")
        .run(move |app, event| {
            match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Destroyed,
                    ..
                } if recovery_only => {
                    let is_last_window = app.webview_windows().keys().all(|other| other != &label);
                    if is_last_window {
                        if let Some(lifecycle) = app.try_state::<RecoveryOnlyLifecycle>() {
                            if lifecycle.recovery_window_destroyed(true) {
                                app.exit(0);
                            }
                        } else {
                            /* Missing lifecycle state is not a reason to leave an
                            otherwise empty RecoveryOnly process orphaned. */
                            app.exit(0);
                        }
                    }
                }
                RunEvent::ExitRequested { api, .. } =>
                {
                    if recovery_only {
                        if let Some(lifecycle) = app.try_state::<RecoveryOnlyLifecycle>() {
                            if lifecycle.defer_exit_while_dry_run_active() {
                                api.prevent_exit();
                            }
                        }
                    } else {
                        #[cfg(desktop)]
                        if let Some(state) = app.try_state::<Arc<HostLifecycle>>() {
                            stop_host_owned_services(state.inner().as_ref());
                        }
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod c35_runner_report_tests {
    use super::*;

    fn synthetic_target_path() -> &'static str {
        "C:\\C35-Synthetic\\InternalBeyond\\home-node\\home-node.db"
    }

    fn synthetic_report() -> serde_json::Value {
        serde_json::json!({
            "schema": C35_RECONSTRUCTION_REPORT_SCHEMA,
            "reportType": C35_RECONSTRUCTION_REPORT_TYPE,
            "version": 1,
            "executionIdentity": "p32w5-r3c3-c3.5-dryrun:12345678-1234-1234-1234-123456789abc",
            "planIdentity": {
                "planId": C35_PLAN_ID,
                "planSha256": C35_PLAN_SHA256,
                "targetSnapshotSha256": C35_TARGET_SNAPSHOT_SHA256
            },
            "bundleIdentity": { "bundleId": C35_BUNDLE_ID, "bundleSha256": C35_BUNDLE_SHA256 },
            "writeSetIdentities": { "A": C35_WRITE_SET_A_SHA256, "B": C35_WRITE_SET_B_SHA256 },
            "targetIdentity": {
                "databaseName": "home-node.db",
                "path": synthetic_target_path(),
                "c1ObservedDatabaseSha256": C35_HOME_NODE_TARGET_SHA256,
                "schemaUserVersion": 0,
                "integrityCheck": "ok"
            },
            "status": "DRY_RUN_PASS",
            "writesStarted": false,
            "automaticRepair": false,
            "blockers": [],
            "writeSetA": { "planned": 500, "operationCounts": { "INSERT": 500, "UPDATE": 0, "DELETE": 0 } },
            "writeSetB": { "planned": 8, "operationCounts": { "INSERT": 0, "UPDATE": 8, "DELETE": 0 } },
            "provenance": {
                "recordCount": 539,
                "traceDigest": C35_PROVENANCE_DIGEST,
                "sourcePrimarySha256": C35_SOURCE_PRIMARY_SHA256
            },
            "authorityArtifacts": {
                "matrixSha256": C35_AUTHORITY_MATRIX_SHA256,
                "conflictResolutionSha256": C35_CONFLICT_RESOLUTION_SHA256,
                "c2ReportSha256": C35_C2_REPORT_SHA256
            },
            "runtimeBoundary": {
                "recoveryOnly": true,
                "normalRuntimeStopped": true,
                "activeQuarantined": true,
                "consumedMarkerPresent": false,
                "protectedPortsReleased": true,
                "providerCalls": 0,
                "secretAccess": false,
                "specJsonRead": false,
                "specJsonWrite": false,
                "runtimeBindingChanged": false,
                "providerBindingChanged": false
            },
            "activity": {
                "productionWrites": 0,
                "homeNodeWrites": 0,
                "indexedDbWrites": 0,
                "providerCalls": 0,
                "secretAccess": 0,
                "specJsonReads": 0,
                "specJsonWrites": 0,
                "approvalIssued": 0,
                "checkpointCreated": 0,
                "applyWindowOpened": 0
            }
        })
    }

    fn synthetic_invalid_sidecar_report() -> serde_json::Value {
        let entries = serde_json::json!([
            { "suffix": "-wal", "exists": true, "sizeBytes": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "structureStatus": "EMPTY" },
            { "suffix": "-shm", "exists": true, "sizeBytes": 32768,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "structureStatus": "INVALID_WAL_INDEX_PAGE_SIZE" }
        ]);
        let basis = serde_json::json!({
            "schema": "internalbeyond.p32-w5.r3-c3.5-sidecar-metadata",
            "version": 1,
            "entries": entries
        });
        let metadata_hash = sha256_hex(&serde_json::to_vec(&basis).unwrap());
        let mut report = synthetic_report();
        report["targetIdentity"] = serde_json::json!({
            "databaseName": "home-node.db",
            "path": synthetic_target_path(),
            "c1ObservedDatabaseSha256": C35_HOME_NODE_TARGET_SHA256,
            "identityBinding": "FROZEN_C1_DATABASE_SHA256_MATCH"
        });
        report["status"] = serde_json::json!("DRY_RUN_BLOCKED");
        report["ok"] = serde_json::json!(false);
        report["writeAllowed"] = serde_json::json!(false);
        report["applyAllowed"] = serde_json::json!(false);
        report["failureStage"] = serde_json::json!("adapter_open");
        report["failureCode"] = serde_json::json!("C35_HOME_NODE_SIDECAR_INVALID");
        report["reasonCode"] = serde_json::json!("C35_HOME_NODE_SIDECAR_INVALID");
        report["blockers"] = serde_json::json!(["C35_HOME_NODE_SIDECAR_INVALID"]);
        report["sidecarMetadataHash"] = serde_json::json!(metadata_hash);
        report["sidecarAudit"] = serde_json::json!({
            "schema": "internalbeyond.p32-w5.r3-c3.5-sidecar-audit",
            "version": 1,
            "metadataHash": metadata_hash,
            "entries": entries,
            "holderAudit": {
                "method": "WINDOWS_RESTART_MANAGER_READ_ONLY",
                "available": true,
                "resources": [
                    { "suffix": "-wal", "exists": true, "holderCount": 0 },
                    { "suffix": "-shm", "exists": true, "holderCount": 0 }
                ]
            }
        });
        report
    }

    fn check_value(exit_code: i32, report: &serde_json::Value, stderr: &[u8]) -> C35RunnerOutputCheck {
        let bytes = serde_json::to_vec(report).unwrap();
        c35_check_runner_output(Some(exit_code), &bytes, stderr, synthetic_target_path())
    }

    #[test]
    fn valid_report_passes() {
        let checked = check_value(0, &synthetic_report(), &[]);
        assert!(checked.reason_code.is_none());
        assert_eq!(checked.report.unwrap()["status"], "DRY_RUN_PASS");
    }

    #[test]
    fn valid_invalid_sidecar_failure_report_is_accepted() {
        let checked = check_value(2, &synthetic_invalid_sidecar_report(), &[]);
        assert!(checked.reason_code.is_none(), "{:?}", checked.reason_code);
        let report = checked.report.unwrap();
        assert_eq!(report["failureCode"], "C35_HOME_NODE_SIDECAR_INVALID");
        assert_eq!(report["ok"], false);
        assert_eq!(report["writeAllowed"], false);
        assert_eq!(report["applyAllowed"], false);
        assert_eq!(report["activity"]["homeNodeWrites"], 0);
        assert_eq!(report["sidecarMetadataHash"], "d26bca3cf4923b559919d8976e7f823d42025c1a3717f0b4db6b160a92ccfc6e");
    }

    #[test]
    fn ui_request_binding_requires_schema_and_version_and_hashes_only_descriptor() {
        let binding = c35_ui_request_binding(C35_UI_DRY_RUN_REQUEST_SCHEMA, 1).unwrap();
        assert_eq!(binding["schema"], C35_UI_DRY_RUN_REQUEST_SCHEMA);
        assert_eq!(binding["version"], 1);
        assert_eq!(binding["fieldNames"], serde_json::json!(["requestSchema", "requestVersion"]));
        assert_eq!(binding["requiredFieldPresence"]["requestSchema"], true);
        assert_eq!(binding["requiredFieldPresence"]["requestVersion"], true);
        assert_eq!(binding["canonicalRequestSha256"].as_str().unwrap().len(), 64);
        assert!(c35_validate_ui_request_binding(C35_UI_DRY_RUN_REQUEST_SCHEMA, 1).is_ok());
        assert_eq!(c35_validate_ui_request_binding(C35_UI_DRY_RUN_REQUEST_SCHEMA, 2).unwrap_err(), "C35_UI_REQUEST_IDENTITY_INVALID");
    }

    #[test]
    fn child_probe_request_binding_is_versioned_and_rejects_other_identity() {
        let binding = c35_child_probe_request_binding(C35_CHILD_PROBE_REQUEST_SCHEMA, 1).unwrap();
        assert_eq!(binding["schema"], C35_CHILD_PROBE_REQUEST_SCHEMA);
        assert_eq!(binding["version"], 1);
        assert_eq!(binding["fieldNames"], serde_json::json!(["requestSchema", "requestVersion"]));
        assert_eq!(binding["requiredFieldPresence"]["requestSchema"], true);
        assert_eq!(binding["requiredFieldPresence"]["requestVersion"], true);
        assert_eq!(binding["canonicalRequestSha256"].as_str().unwrap().len(), 64);
        assert!(c35_child_probe_request_binding(C35_CHILD_PROBE_REQUEST_SCHEMA, 2).is_err());
        assert!(c35_child_probe_request_binding("other", 1).is_err());
    }

    #[test]
    fn native_spawn_context_hashes_paths_and_records_space_unicode_argument_shape() {
        let root = std::env::temp_dir().join(format!("c35 native child root 测试 {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("node test 子.exe");
        fs::write(&executable, b"synthetic executable identity").unwrap();
        let arguments = vec![OsString::from("child probe 子进程.js")];
        let context = c35_native_spawn_context(&root, &executable, &arguments);
        let serialized = context.to_string();
        assert_eq!(context["executableSha256"], sha256_hex(b"synthetic executable identity"));
        assert_eq!(context["argumentCount"], 1);
        assert_eq!(context["argumentContainsSpace"], true);
        assert_eq!(context["argumentContainsNonAscii"], true);
        assert_eq!(context["argvCanonicalSha256"].as_str().unwrap().len(), 64);
        assert_eq!(context["cwdSha256"].as_str().unwrap().len(), 64);
        assert_eq!(context["environmentInherited"], true);
        assert_eq!(context["explicitEnvironmentOverrides"], 0);
        assert_eq!(context["shell"], false);
        assert_eq!(context["stdio"]["stdin"], "piped-empty-then-closed");
        assert_eq!(context["stdio"]["stdout"], "piped-captured");
        assert_eq!(context["stdio"]["stderr"], "piped-captured");
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
        assert!(!serialized.contains("child probe 子进程.js"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_argv_path_converts_extended_drive_to_plain_absolute() {
        let input = Path::new(r"\\?\C:\Program Files\InternalBeyond\runner.js");
        assert_eq!(windows_child_argv_path(input).unwrap(), PathBuf::from(r"C:\Program Files\InternalBeyond\runner.js"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_argv_path_keeps_plain_absolute_unchanged() {
        let input = PathBuf::from(r"C:\InternalBeyond\runner.js");
        assert_eq!(windows_child_argv_path(&input).unwrap(), input);
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_argv_path_preserves_spaces() {
        let input = Path::new(r"\\?\C:\Program Files\Internal Beyond\runner.js");
        assert_eq!(windows_child_argv_path(input).unwrap(), PathBuf::from(r"C:\Program Files\Internal Beyond\runner.js"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_argv_path_preserves_unicode() {
        let input = Path::new(r"\\?\C:\应用程序\内部Beyond\runner.js");
        assert_eq!(windows_child_argv_path(input).unwrap(), PathBuf::from(r"C:\应用程序\内部Beyond\runner.js"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_argv_path_rejects_extended_unc_fail_closed() {
        let input = Path::new(r"\\?\UNC\server\share\runner.js");
        assert_eq!(windows_child_argv_path(input).unwrap_err(), "C35_CHILD_ARGV_EXTENDED_UNC_UNSUPPORTED");
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_argv_path_rejects_relative_input() {
        let input = Path::new(r"services\home-node\runner.js");
        assert_eq!(windows_child_argv_path(input).unwrap_err(), "C35_CHILD_ARGV_PATH_NOT_ABSOLUTE");
    }

    #[cfg(windows)]
    #[test]
    fn normalized_child_argv_path_resolves_to_same_file_and_bytes() {
        let root = std::env::temp_dir().join(format!("C35 argv identity 测试 {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source_file = root.join("synthetic child 子.js");
        fs::write(&source_file, b"process.stdout.write('C35_NODE_ENTRY_REACHED\\n');\n").unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let canonical_source = fs::canonicalize(&source_file).unwrap();
        let normalized = c35_normalized_child_script_argv(&canonical_source, &canonical_root).unwrap();
        assert_eq!(fs::canonicalize(&normalized).unwrap(), canonical_source);
        assert_eq!(c35_file_sha256(&canonical_source), c35_file_sha256(&normalized));
        assert!(!normalized.to_string_lossy().starts_with("\\\\?\\"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn c35_k3_normalized_synthetic_child_reaches_javascript_entry() {
        let local_app_data = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap());
        let root = fs::canonicalize(local_app_data.join("Programs/InternalBeyond")).unwrap();
        let executable = fs::canonicalize(root.join("runtime/node/node.exe")).unwrap();
        let source = fs::canonicalize(root.join(C35_CHILD_PROBE_SCRIPT_RELATIVE_PATH)).unwrap();
        let normalized = c35_normalized_child_script_argv(&source, &root).unwrap();
        let arguments = vec![normalized.as_os_str().to_os_string()];
        let capture = c35_spawn_native_child(&executable, &arguments, &root, None);
        let output = capture.output.as_ref().expect("synthetic Node child should exit");
        let stdout = output.stdout.as_slice();
        let stderr = output.stderr.as_slice();
        let marker_seen = std::str::from_utf8(stdout).ok().map(|text| text.lines().any(|line| line.trim_end_matches('\r') == C35_NODE_ENTRY_MARKER)).unwrap_or(false);
        println!("C35_K3_SHARED_HELPER_SYNTHETIC {{\"exitCode\":{},\"stdoutBytes\":{},\"stdoutSha256\":\"{}\",\"stderrBytes\":{},\"stderrSha256\":\"{}\",\"markerSeen\":{},\"rawStderrStored\":false}}",
            output.status.code().unwrap_or(-1), stdout.len(), sha256_hex(stdout), stderr.len(), sha256_hex(stderr), marker_seen);
        assert_eq!(output.status.code(), Some(0));
        assert_eq!(stdout, b"C35_NODE_ENTRY_REACHED\n");
        assert!(stderr.is_empty());
        assert!(marker_seen);
        assert!(!capture.spawn_failed && !capture.wait_failed && !capture.stdin_write_failed);
    }

    #[test]
    fn host_invocation_snapshot_contains_hashes_presence_and_bounded_context_only() {
        let root = std::env::temp_dir().join(format!("c35-invocation-snapshot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let node = root.join("node.exe");
        let runner = root.join("reconstruction-runner.js");
        fs::write(&node, b"synthetic node bytes").unwrap();
        fs::write(&runner, b"synthetic runner bytes").unwrap();
        let snapshot = c35_host_invocation_snapshot(&root, &node, &runner, &runner);
        let serialized = snapshot.to_string();
        assert_eq!(snapshot["nodeExecutableSha256"], sha256_hex(b"synthetic node bytes"));
        assert_eq!(snapshot["runnerSha256"], sha256_hex(b"synthetic runner bytes"));
        assert_eq!(snapshot["childArgvCanonicalSha256"].as_str().unwrap().len(), 64);
        assert_eq!(snapshot["hostArgvCanonicalSha256"].as_str().unwrap().len(), 64);
        assert!(snapshot["selectedEnvironmentPresenceAndHashes"]["PATH"]["present"].is_boolean());
        assert!(snapshot["sessionId"].is_number() || snapshot["sessionId"].is_null());
        assert!(matches!(snapshot["integrityLevel"].as_str(), Some("UNTRUSTED" | "LOW" | "MEDIUM" | "HIGH" | "SYSTEM" | "PROTECTED" | "UNAVAILABLE")));
        for name in ["PATH", "NODE_OPTIONS", "LOCALAPPDATA"] {
            if let Ok(value) = std::env::var(name) {
                assert!(!serialized.contains(&value), "raw {name} value leaked into snapshot");
            }
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn invalid_sidecar_report_rejects_missing_failure_policy_fields() {
        let mut report = synthetic_invalid_sidecar_report();
        report.as_object_mut().unwrap().remove("writeAllowed");
        let checked = check_value(2, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_SIDECAR_FAILURE_POLICY_INVALID"));
    }

    #[test]
    fn invalid_sidecar_report_rejects_wrong_target_identity() {
        let mut report = synthetic_invalid_sidecar_report();
        report["targetIdentity"]["path"] = serde_json::json!("C:\\C35-Synthetic\\other.db");
        let checked = check_value(2, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_TARGET_IDENTITY_MISMATCH"));
    }

    #[test]
    fn invalid_sidecar_report_rejects_malformed_sidecar_metadata_binding() {
        let mut report = synthetic_invalid_sidecar_report();
        report["sidecarMetadataHash"] = serde_json::json!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        report["sidecarAudit"]["metadataHash"] = report["sidecarMetadataHash"].clone();
        let checked = check_value(2, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_SIDECAR_METADATA_HASH_MISMATCH"));
    }

    #[test]
    fn invalid_sidecar_report_rejects_nonzero_activity() {
        let mut report = synthetic_invalid_sidecar_report();
        report["activity"]["homeNodeWrites"] = serde_json::json!(1);
        let checked = check_value(2, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_DRYRUN_ZERO_WRITE_ASSERTION_FAILED"));
    }

    #[cfg(windows)]
    #[test]
    fn restart_manager_audits_a_synthetic_unheld_file_read_only() {
        let path = std::env::temp_dir().join(format!("c35-sidecar-holder-{}.tmp", uuid::Uuid::new_v4()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        drop(file);
        let result = c35_windows_resource_holder_count(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(result, Ok(0));
    }

    #[test]
    fn complete_early_block_report_preserves_reason_and_zero_counters() {
        let mut report = synthetic_report();
        let code = "C35_HOME_NODE_WAL_OR_SHM_PRESENT";
        report["status"] = serde_json::json!("DRY_RUN_BLOCKED");
        report["failureStage"] = serde_json::json!("adapter_open");
        report["failureCode"] = serde_json::json!(code);
        report["blockers"] = serde_json::json!([code]);
        report["targetIdentity"] = serde_json::Value::Null;
        report["provenance"] = serde_json::Value::Null;
        report["authorityArtifacts"] = serde_json::Value::Null;
        let checked = check_value(2, &report, &[]);
        assert!(checked.reason_code.is_none());
        assert_eq!(checked.report.unwrap()["failureCode"], code);
    }

    #[test]
    fn empty_stdout_has_its_own_reason() {
        let checked = c35_check_runner_output(Some(2), &[], &[], synthetic_target_path());
        assert_eq!(checked.reason_code.as_deref(), Some("C35_RUNNER_STDOUT_EMPTY"));
    }

    #[test]
    fn invalid_utf8_stdout_has_its_own_reason() {
        let checked = c35_check_runner_output(Some(2), &[b'{', 0xff, b'}'], &[], synthetic_target_path());
        assert_eq!(checked.reason_code.as_deref(), Some("C35_RUNNER_STDOUT_INVALID_UTF8"));
    }

    #[test]
    fn malformed_json_has_its_own_reason() {
        let checked = c35_check_runner_output(Some(2), b"{broken", &[], synthetic_target_path());
        assert_eq!(checked.reason_code.as_deref(), Some("C35_RUNNER_STDOUT_INVALID_JSON"));
    }

    #[test]
    fn stdout_prefix_pollution_has_its_own_reason() {
        let checked = c35_check_runner_output(Some(0), b"runner: {\"schema\":\"x\"}", &[], synthetic_target_path());
        assert_eq!(checked.reason_code.as_deref(), Some("C35_RUNNER_STDOUT_PREFIX_POLLUTION"));
    }

    #[test]
    fn stdout_suffix_pollution_has_its_own_reason() {
        let checked = c35_check_runner_output(Some(0), b"{} extra", &[], synthetic_target_path());
        assert_eq!(checked.reason_code.as_deref(), Some("C35_RUNNER_STDOUT_SUFFIX_POLLUTION"));
    }

    #[test]
    fn nonzero_exit_after_pass_report_is_rejected() {
        let checked = check_value(2, &synthetic_report(), &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_RUNNER_EXIT_NONZERO"));
    }

    #[test]
    fn missing_required_activity_is_rejected() {
        let mut report = synthetic_report();
        report.as_object_mut().unwrap().remove("activity");
        let checked = check_value(0, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_ACTIVITY_MISSING"));
    }

    #[test]
    fn wrong_report_version_is_rejected() {
        let mut report = synthetic_report();
        report["version"] = serde_json::json!(2);
        let checked = check_value(0, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_VERSION_INVALID"));
    }

    #[test]
    fn wrong_report_schema_is_rejected() {
        let mut report = synthetic_report();
        report["schema"] = serde_json::json!("internalbeyond.other-report");
        let checked = check_value(0, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_SCHEMA_INVALID"));
    }

    #[test]
    fn wrong_report_type_is_rejected() {
        let mut report = synthetic_report();
        report["reportType"] = serde_json::json!("OTHER_REPORT");
        let checked = check_value(0, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_TYPE_INVALID"));
    }

    #[test]
    fn wrong_bundle_identity_is_rejected() {
        let mut report = synthetic_report();
        report["bundleIdentity"]["bundleSha256"] = serde_json::json!("0".repeat(64));
        let checked = check_value(0, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_BUNDLE_IDENTITY_MISMATCH"));
    }

    #[test]
    fn wrong_write_set_identity_is_rejected() {
        let mut report = synthetic_report();
        report["writeSetIdentities"]["B"] = serde_json::json!("0".repeat(64));
        let checked = check_value(0, &report, &[]);
        assert_eq!(checked.reason_code.as_deref(), Some("C35_REPORT_WRITESET_IDENTITY_MISMATCH"));
    }

    #[test]
    fn stderr_is_summarized_without_emitting_raw_text() {
        let report = synthetic_report();
        let bytes = serde_json::to_vec(&report).unwrap();
        let stderr = b"Error: private sample payload; C35_HOME_NODE_WAL_OR_SHM_PRESENT";
        let checked = c35_check_runner_output(Some(0), &bytes, stderr, synthetic_target_path());
        assert!(checked.reason_code.is_none());
        let summary = checked.diagnostic.to_string();
        assert!(summary.contains("C35_HOME_NODE_WAL_OR_SHM_PRESENT"));
        assert!(!summary.contains("private sample payload"));
        assert!(summary.contains("byteLength"));
        assert!(summary.contains("sha256"));
    }

    #[test]
    fn bootstrap_markers_are_allowlisted_and_raw_stderr_is_not_projected() {
        let stderr = b"C35_NODE_ENTRY_REACHED\nC35_BOOTSTRAP_STARTED\nC35_BOOTSTRAP_MODULES_OK\nsecret-path-and-error\nC35_BOOTSTRAP_UNKNOWN\n";
        let diagnostic = c35_runner_diagnostic_value(Some(1), b"", stderr, "stdout_empty", Some("C35_RUNNER_STDOUT_EMPTY"), None);
        assert_eq!(diagnostic["bootstrapStages"], serde_json::json!([
            "C35_NODE_ENTRY_REACHED", "C35_BOOTSTRAP_STARTED", "C35_BOOTSTRAP_MODULES_OK"
        ]));
        let encoded = diagnostic.to_string();
        assert!(!encoded.contains("secret-path-and-error"));
        assert!(!encoded.contains("C35_BOOTSTRAP_UNKNOWN"));
    }

    #[test]
    fn bootstrap_marker_only_stderr_gets_safe_classification() {
        let stderr = b"C35_BOOTSTRAP_STARTED\nC35_BOOTSTRAP_ARGS_OK\nC35_BOOTSTRAP_ADAPTER_FAILED\n";
        let diagnostic = c35_runner_diagnostic_value(Some(2), b"{}", stderr, "process_exit", None, None);
        assert_eq!(diagnostic.pointer("/stderr/classification").and_then(serde_json::Value::as_str), Some("BOOTSTRAP_MARKERS_ONLY"));
    }
}

#[cfg(test)]
mod recovery_only_lifecycle_tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    struct SyntheticAdapterResources(Arc<AtomicBool>);

    impl Drop for SyntheticAdapterResources {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn recovery_only_window_close_exits_when_idle() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        assert!(lifecycle.recovery_window_destroyed(true));
    }

    #[test]
    fn last_window_destroyed_requests_exit_exactly_once() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        assert!(lifecycle.recovery_window_destroyed(true));
        assert!(!lifecycle.recovery_window_destroyed(true));
    }

    #[test]
    fn non_last_window_destroyed_does_not_exit() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        assert!(!lifecycle.recovery_window_destroyed(false));
        assert!(lifecycle.begin_dry_run().is_ok());
        assert!(!lifecycle.finish_dry_run());
    }

    #[test]
    fn active_dry_run_prevents_premature_exit_and_new_work_after_close() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        lifecycle.begin_dry_run().unwrap();
        assert!(!lifecycle.recovery_window_destroyed(true));
        assert!(lifecycle.begin_dry_run().is_err());
        assert!(lifecycle.finish_dry_run());
    }

    #[test]
    fn runner_completion_allows_pending_exit() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        lifecycle.begin_dry_run().unwrap();
        assert!(!lifecycle.recovery_window_destroyed(true));
        assert!(lifecycle.finish_dry_run());
    }

    #[test]
    fn adapter_resources_close_before_pending_exit_is_released() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        let closed = Arc::new(AtomicBool::new(false));
        let resources = SyntheticAdapterResources(Arc::clone(&closed));
        lifecycle.begin_dry_run().unwrap();
        assert!(!lifecycle.recovery_window_destroyed(true));
        drop(resources);
        assert!(closed.load(Ordering::Acquire));
        assert!(lifecycle.finish_dry_run());
    }

    #[test]
    fn window_close_requests_only_exit_without_starting_reconstruction() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        assert!(lifecycle.recovery_window_destroyed(true));
        let state = lifecycle.state.lock().unwrap();
        assert_eq!(state.active_dry_runs, 0);
        assert!(state.exit_requested);
    }

    #[test]
    fn repeated_close_and_completion_do_not_double_exit() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        lifecycle.begin_dry_run().unwrap();
        assert!(!lifecycle.recovery_window_destroyed(true));
        assert!(lifecycle.finish_dry_run());
        assert!(!lifecycle.finish_dry_run());
        assert!(!lifecycle.recovery_window_destroyed(true));
    }

    #[test]
    fn external_exit_request_is_deferred_until_active_dry_run_finishes() {
        let lifecycle = RecoveryOnlyLifecycle::default();
        lifecycle.begin_dry_run().unwrap();
        assert!(lifecycle.defer_exit_while_dry_run_active());
        assert!(lifecycle.begin_dry_run().is_err());
        assert!(lifecycle.finish_dry_run());
        assert!(!lifecycle.defer_exit_while_dry_run_active());
    }
}

#[cfg(test)]
mod runtime_authority_tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;

    fn synthetic_recovery_checkpoint() -> RecoveryCheckpoint {
        let plan_hash = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let selected_domains = RECOVERY_DOMAINS
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        let before_stores = RECOVERY_DOMAINS
            .iter()
            .map(|value| RecoveryStoreSnapshot {
                name: value.to_string(),
                count: 0,
                keys: vec![],
            })
            .collect::<Vec<_>>();
        let planned_writes = RECOVERY_DOMAIN_COUNTS
            .iter()
            .flat_map(|(domain, count)| {
                (0..*count).map(move |index| RecoveryPlannedWrite {
                    store: domain.to_string(),
                    key: format!("{domain}-synthetic-{index:04}"),
                    record_sha256: "c".repeat(64),
                })
            })
            .collect::<Vec<_>>();
        let mut checkpoint = RecoveryCheckpoint {
            schema: RECOVERY_CHECKPOINT_SCHEMA.to_string(),
            version: 1,
            phase: "PREPARED".to_string(),
            plan_id: format!("r3b3:{plan_hash}"),
            plan_hash: plan_hash.clone(),
            frozen_plan_id: APPROVED_FROZEN_PLAN_ID.to_string(),
            frozen_plan_hash: APPROVED_FROZEN_PLAN_SHA256.to_string(),
            frozen_artifact_sha256: APPROVED_FROZEN_ARTIFACT_SHA256.to_string(),
            transaction_id: format!("r3b3-tx:{plan_hash}"),
            lifecycle_id: "0".repeat(32),
            integrity_sha256: String::new(),
            source_sha256: APPROVED_RECOVERY_SOURCE_SHA256.to_string(),
            source_size: APPROVED_RECOVERY_SOURCE_SIZE,
            export_version: APPROVED_RECOVERY_EXPORT_VERSION,
            supplemental_role_source_sha256: APPROVED_RECOVERY_ROLE_SOURCE_SHA256.to_string(),
            supplemental_memory_source_sha256: APPROVED_RECOVERY_MEMORY_SOURCE_SHA256.to_string(),
            authority_type: APPROVED_AUTHORITY_TYPE.to_string(),
            authority_status: APPROVED_AUTHORITY_STATUS.to_string(),
            authority_revision_id: APPROVED_AUTHORITY_REVISION_ID.to_string(),
            authority_revision_sha256: APPROVED_AUTHORITY_REVISION_SHA256.to_string(),
            provenance_digest: APPROVED_PROVENANCE_SHA256.to_string(),
            provenance_record_count: APPROVED_PROVENANCE_COUNT,
            target_snapshot_sha256: "a".repeat(64),
            execution_phase: "R3-B.3".to_string(),
            target_origin: "http://tauri.localhost:43127".to_string(),
            target_identity: format!(
                "com.internalbeyond.desktop|canonical-inno|C:\\Synthetic\\Install|1.0.6|{}",
                "e".repeat(64)
            ),
            database_name: "InternalBeyondDB".to_string(),
            schema_version: 24,
            selected_domains: selected_domains.clone(),
            stores: selected_domains,
            before_stores,
            planned_writes,
            first_boot_pending: true,
            active_quarantined: true,
            created_at: "unix-ms:1700000000000".to_string(),
        };
        checkpoint.integrity_sha256 = recovery_checkpoint_integrity_sha256(&checkpoint).unwrap();
        checkpoint
    }

    fn synthetic_temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ib-{label}-{}-{nonce}", std::process::id()))
    }

    fn synthetic_issued_approval(
        root: &Path,
    ) -> (
        ExplicitRestoreApproval,
        RecoveryApprovalBinding,
        RecoveryOnlyHostState,
        RecoveryCheckpoint,
    ) {
        let mut checkpoint = synthetic_recovery_checkpoint();
        let binding = approval_binding_from_checkpoint(&checkpoint).unwrap();
        let prompt = native_approval_prompt_text(&binding);
        assert!(prompt.contains(&binding.plan_id));
        assert!(prompt.contains(&binding.plan_hash));
        assert!(prompt.contains(&binding.source_sha256));
        assert!(prompt.contains(&binding.supplemental_role_source_sha256));
        assert!(prompt.contains(&binding.supplemental_memory_source_sha256));
        assert!(prompt.contains(&binding.authority_type));
        assert!(prompt.contains(&binding.target_identity));
        let host = RecoveryOnlyHostState {
            target_identity: checkpoint.target_identity.clone(),
            target_origin: checkpoint.target_origin.clone(),
            active_quarantined: true,
            reconstruction_dry_run_only: false,
        };
        let request = RecoveryApprovalIssueRequest {
            kind: RECOVERY_APPROVAL_KIND.to_string(),
            confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
            entered_plan_id: binding.plan_id.clone(),
            entered_plan_hash: binding.plan_hash.clone(),
            plan: binding.clone(),
        };
        let approval = issue_recovery_approval_inner(request, &host, root).unwrap();
        checkpoint.lifecycle_id = approval.lifecycle_id.clone();
        checkpoint.integrity_sha256 = recovery_checkpoint_integrity_sha256(&checkpoint).unwrap();
        (approval, binding, host, checkpoint)
    }

    #[test]
    fn recovery_finalize_boot_policy_matrix() {
        /* FirstBootPending -> ActiveQuarantine -> Finalize Normal, plus
           finalize-invalid (foreign plan) and finalize-replay. */
        let root = synthetic_temp_root("recovery-finalize-policy");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, checkpoint) = synthetic_issued_approval(&root);
        persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();
        let checkpoint_bytes = fs::read(checkpoint_path(&root)).unwrap();
        let checkpoint_file_sha256 = sha256_hex(&checkpoint_bytes);

        let verified = RecoveryCheckpointVerifiedMarker {
            schema: "internalbeyond.recovery-checkpoint-verified".to_string(),
            version: 1,
            plan_id: checkpoint.plan_id.clone(),
            verified_at: chrono_free_timestamp(),
        };
        write_new_json(&verified_marker_path(&root), &verified).unwrap();

        /* (1) FirstBootPending */
        assert_eq!(
            recovery_boot_policy_from_dir(&root).mode,
            RecoveryBootMode::FirstBootPending
        );

        /* (2) ActiveQuarantine after consuming the first-boot marker */
        let consumed = RecoveryFirstBootConsumed {
            schema: RECOVERY_CONSUMED_SCHEMA.to_string(),
            version: 1,
            plan_id: checkpoint.plan_id.clone(),
            consumed_at: chrono_free_timestamp(),
        };
        write_new_json(&consumed_marker_path(&root), &consumed).unwrap();
        assert_eq!(
            recovery_boot_policy_from_dir(&root).mode,
            RecoveryBootMode::ActiveQuarantine
        );

        /* (3) Finalize success -> Normal, checkpoint retained */
        let marker = RecoveryFinalizedMarker {
            schema: RECOVERY_FINALIZED_SCHEMA.to_string(),
            version: 1,
            plan_id: checkpoint.plan_id.clone(),
            lifecycle_id: checkpoint.lifecycle_id.clone(),
            checkpoint_file_sha256: checkpoint_file_sha256.clone(),
            verified_at: verified.verified_at.clone(),
            credential_ready_digest: "d".repeat(64),
            authorized_at: chrono_free_timestamp(),
        };
        write_new_json(&finalized_marker_path(&root), &marker).unwrap();
        assert_eq!(
            recovery_boot_policy_from_dir(&root).mode,
            RecoveryBootMode::Normal
        );
        assert!(checkpoint_path(&root).exists());

        /* (5) Finalize replay: re-reading the policy stays Normal */
        assert!(read_finalized_marker_valid_for(
            &root,
            &checkpoint.plan_id,
            &checkpoint.lifecycle_id,
            &checkpoint_file_sha256
        )
        .is_some());
        assert_eq!(
            recovery_boot_policy_from_dir(&root).mode,
            RecoveryBootMode::Normal
        );

        /* (4) Finalize invalid (foreign plan) does not unlock */
        let foreign_root = synthetic_temp_root("recovery-finalize-foreign");
        fs::create_dir_all(&foreign_root).unwrap();
        let (f_approval, f_binding, _f_host, f_checkpoint) =
            synthetic_issued_approval(&foreign_root);
        persist_checkpoint_lifecycle_artifacts_with(
            &foreign_root,
            &f_checkpoint,
            &f_approval,
            &f_binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();
        let f_bytes = fs::read(checkpoint_path(&foreign_root)).unwrap();
        write_new_json(
            &verified_marker_path(&foreign_root),
            &RecoveryCheckpointVerifiedMarker {
                schema: "internalbeyond.recovery-checkpoint-verified".to_string(),
                version: 1,
                plan_id: f_checkpoint.plan_id.clone(),
                verified_at: chrono_free_timestamp(),
            },
        )
        .unwrap();
        let foreign = RecoveryFinalizedMarker {
            schema: RECOVERY_FINALIZED_SCHEMA.to_string(),
            version: 1,
            plan_id: "r3b3:foreign".to_string(),
            lifecycle_id: f_checkpoint.lifecycle_id.clone(),
            checkpoint_file_sha256: sha256_hex(&f_bytes),
            verified_at: "unix-ms:1".to_string(),
            credential_ready_digest: "e".repeat(64),
            authorized_at: "unix-ms:1".to_string(),
        };
        write_new_json(&finalized_marker_path(&foreign_root), &foreign).unwrap();
        assert_eq!(
            recovery_boot_policy_from_dir(&foreign_root).mode,
            RecoveryBootMode::FirstBootPending
        );

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&f_approval.token);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&foreign_root).unwrap();
    }

    fn synthetic_apply_window_approval(
        root: &Path,
    ) -> (
        ExplicitRestoreApproval,
        RecoveryApprovalBinding,
        RecoveryOnlyHostState,
        RecoveryCheckpoint,
    ) {
        let (approval, binding, host, checkpoint) = synthetic_issued_approval(root);
        write_recovery_checkpoint_inner(checkpoint.clone(), approval.clone(), &host, root).unwrap();
        (approval, binding, host, checkpoint)
    }

    fn synthetic_write_checkpoint_lifecycle_files(root: &Path, checkpoint: &RecoveryCheckpoint) {
        let intent =
            make_recovery_checkpoint_lifecycle(checkpoint, &checkpoint.lifecycle_id, "RESERVED")
                .unwrap();
        write_new_json(&checkpoint_lifecycle_intent_path(root), &intent).unwrap();
        write_new_json(&checkpoint_path(root), checkpoint).unwrap();
        let mut ready = intent;
        ready.phase = "READY".to_string();
        ready.record_sha256 = recovery_checkpoint_lifecycle_hash(&ready).unwrap();
        write_new_json(&checkpoint_lifecycle_ready_path(root), &ready).unwrap();
    }

    #[test]
    fn release_defaults_to_production() {
        assert_eq!(RuntimeMode::parse(None, false), Ok(RuntimeMode::Production));
    }

    #[test]
    fn debug_defaults_to_development() {
        assert_eq!(RuntimeMode::parse(None, true), Ok(RuntimeMode::Development));
    }

    #[test]
    fn release_development_mode_is_rejected() {
        assert!(RuntimeMode::parse(Some("development"), false).is_err());
    }

    #[test]
    fn acceptance_mode_is_explicit() {
        assert_eq!(
            RuntimeMode::parse(Some("acceptance"), false),
            Ok(RuntimeMode::Acceptance)
        );
    }

    #[test]
    fn production_marker_name_is_canonical() {
        assert_eq!(PAYLOAD_MANIFEST, "ib-payload-manifest.json");
    }

    #[test]
    fn recovery_only_requires_an_explicit_argument_and_never_selects_normal_services() {
        let normal = host_entry_mode(vec![OsString::from("internalbeyond-host.exe")]);
        let recovery = host_entry_mode(vec![
            OsString::from("internalbeyond-host.exe"),
            OsString::from("--recovery-only"),
        ]);
        assert_eq!(normal, HostEntryMode::Normal);
        assert_eq!(recovery, HostEntryMode::RecoveryOnly);
        assert!(host_starts_normal_services(normal));
        assert!(!host_starts_normal_services(recovery));
        assert!(args_request_recovery_only(&["--recovery-only".to_string()]));
        assert!(!args_request_recovery_only(&["--version".to_string()]));
        let dry_run_args = vec!["--recovery-only".to_string(), C35_RECONSTRUCTION_DRY_RUN_ARG.to_string()];
        assert!(host_requests_c35_dry_run(&dry_run_args));
        assert!(!host_requests_c35_dry_run(&[C35_RECONSTRUCTION_DRY_RUN_ARG.to_string()]));
    }

    #[test]
    fn recovery_only_requires_its_static_shell_and_adapter_payload() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ib-recovery-payload-{}-{nonce}",
            std::process::id()
        ));
        for rel in [
            "Recovery.html",
            "assets/js/webcore-db-schema.js",
            "assets/js/recovery-engine.js",
            "assets/js/composite-recovery-plan.js",
            "assets/js/recovery-webcore-adapter.js",
            "assets/js/recovery-production-adapter.js",
            "assets/js/recovery-apply-executor.js",
            "assets/js/recovery-first-boot.js",
            "assets/js/recovery-source-manifest.js",
            "assets/js/recovery-ui.js",
            "assets/js/recovery-shell.js",
            "assets/js/recovery-c3-5-reconstruction.js",
            "services/home-node/reconstruction-runner.js",
            "services/home-node/production-reconstruction-adapter.js",
            "services/home-node/composite-reconstruction-executor.js",
            "services/home-node/composite-reconstruction-approval.js",
            "services/home-node/character-projection-store.js",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/composite-bundle.json",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-reconstruction-write-set.json",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/character-projection-write-set.json",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-proposed-write-set.json",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/character-field-authority-matrix.json",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/character-conflict-resolution.json",
            "services/home-node/reconstruction-contracts/p32-w5-r3c3/c2-authority-report.json",
        ] {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "synthetic").unwrap();
        }
        assert!(recovery_payload_is_complete(&root).is_ok());
        fs::remove_file(root.join("Recovery.html")).unwrap();
        assert!(recovery_payload_is_complete(&root).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn production_restore_and_apply_gates_are_hard_closed() {
        assert!(!PRODUCTION_RESTORE_ENABLED);
        let checkpoint = synthetic_recovery_checkpoint();
        assert!(validate_recovery_checkpoint(&checkpoint).is_ok());
        let root = synthetic_temp_root("recovery-approval-contract");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, _checkpoint) = synthetic_apply_window_approval(&root);
        assert!(validate_restore_approval(&approval, &binding).is_ok());
        let mut wrong_phrase = approval.clone();
        wrong_phrase.confirmation = "continue".to_string();
        assert!(validate_restore_approval(&wrong_phrase, &binding).is_err());
        let mut wrong_hash = approval.clone();
        wrong_hash.plan_hash = "0".repeat(64);
        assert!(validate_restore_approval(&wrong_hash, &binding).is_err());
        let mut expired = approval.clone();
        expired.expires_at = 0;
        assert_eq!(
            validate_restore_approval(&expired, &binding).unwrap_err(),
            "APPROVAL_TOKEN_EXPIRED"
        );
        let mut wrong_authority = approval;
        wrong_authority.authority_type = "USER_ASSERTED".to_string();
        assert_eq!(
            validate_restore_approval(&wrong_authority, &binding).unwrap_err(),
            "APPROVAL_TOKEN_AUTHORITY_TYPE_MISMATCH"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn p5_8_7_canonical_domain_scope_sorts_and_rejects_invalid_sets() {
        let plan_order: Vec<String> = RECOVERY_DOMAINS
            .iter()
            .map(|domain| domain.to_string())
            .collect();
        let canonical = canonical_recovery_domains(&plan_order).unwrap();
        assert_ne!(canonical, plan_order);
        assert_eq!(canonical_recovery_domains(&canonical).unwrap(), canonical);
        assert_eq!(canonical.len(), RECOVERY_DOMAINS.len());
        assert_eq!(
            RECOVERY_DOMAIN_COUNTS
                .iter()
                .map(|(_, count)| count)
                .sum::<usize>(),
            539
        );

        let mut duplicate = plan_order.clone();
        duplicate.push(plan_order[0].clone());
        assert_eq!(
            canonical_recovery_domains(&duplicate).unwrap_err(),
            "RECOVERY_DOMAIN_DUPLICATE"
        );
        let mut missing = plan_order.clone();
        missing.pop();
        assert_eq!(
            canonical_recovery_domains(&missing).unwrap_err(),
            "RECOVERY_DOMAIN_SCOPE_MISMATCH"
        );
        let mut extra = plan_order;
        extra.push("unexpectedDomain".to_string());
        assert_eq!(
            canonical_recovery_domains(&extra).unwrap_err(),
            "RECOVERY_DOMAIN_UNKNOWN"
        );
    }

    #[test]
    fn p5_8_7_approval_and_plan_order_checkpoint_share_canonical_binding() {
        let root = synthetic_temp_root("p5-8-7-domain-binding");
        let (approval, binding, _host, checkpoint) = synthetic_issued_approval(&root);
        let plan_order: Vec<String> = RECOVERY_DOMAINS
            .iter()
            .map(|domain| domain.to_string())
            .collect();
        assert_eq!(checkpoint.selected_domains, plan_order);
        assert_ne!(binding.selected_domains, checkpoint.selected_domains);
        assert_eq!(
            approval_binding_from_checkpoint(&checkpoint).unwrap(),
            binding
        );

        let mut plan_order_binding = binding.clone();
        plan_order_binding.selected_domains = checkpoint.selected_domains.clone();
        assert_eq!(
            issued_binding_mismatch_code(&binding, &plan_order_binding),
            None
        );
        assert!(validate_restore_approval(&approval, &plan_order_binding).is_ok());
        assert!(
            require_issued_recovery_approval(&approval, &plan_order_binding, Some(false)).is_ok()
        );
        assert!(validate_recovery_checkpoint(&checkpoint).is_ok());
        assert!(!checkpoint_path(&root).exists());
        assert!(!checkpoint_lifecycle_intent_path(&root).exists());
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
    }

    #[test]
    fn approval_token_binding_diagnostics_identify_each_synthetic_predicate() {
        let root = synthetic_temp_root("approval-token-diagnostics");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, _checkpoint) = synthetic_issued_approval(&root);
        let token = approval.token.clone();

        assert!(validate_restore_approval(&approval, &binding).is_ok());
        assert!(require_issued_recovery_approval(&approval, &binding, Some(false)).is_ok());

        let mut wrong_plan_id = approval.clone();
        wrong_plan_id.plan_id.push_str("-wrong");
        assert_eq!(
            validate_restore_approval(&wrong_plan_id, &binding).unwrap_err(),
            "APPROVAL_TOKEN_PLAN_ID_MISMATCH"
        );
        let mut wrong_plan_hash = approval.clone();
        wrong_plan_hash.plan_hash = "0".repeat(64);
        assert_eq!(
            validate_restore_approval(&wrong_plan_hash, &binding).unwrap_err(),
            "APPROVAL_TOKEN_PLAN_HASH_MISMATCH"
        );
        let mut wrong_target = approval.clone();
        wrong_target.target_identity.push_str("-wrong");
        assert_eq!(
            validate_restore_approval(&wrong_target, &binding).unwrap_err(),
            "APPROVAL_TOKEN_TARGET_IDENTITY_MISMATCH"
        );
        let mut wrong_authority = approval.clone();
        wrong_authority.authority_type = "USER_ASSERTED".to_string();
        assert_eq!(
            validate_restore_approval(&wrong_authority, &binding).unwrap_err(),
            "APPROVAL_TOKEN_AUTHORITY_TYPE_MISMATCH"
        );
        let mut wrong_provenance = approval.clone();
        wrong_provenance.provenance_digest = "0".repeat(64);
        assert_eq!(
            validate_restore_approval(&wrong_provenance, &binding).unwrap_err(),
            "APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH"
        );

        macro_rules! assert_token_mismatch {
            ($field:ident, $value:expr, $reason:literal) => {{
                let mut candidate = approval.clone();
                candidate.$field = $value;
                assert_eq!(
                    validate_restore_approval(&candidate, &binding).unwrap_err(),
                    $reason
                );
            }};
        }
        assert_token_mismatch!(
            kind,
            "wrong-kind".to_string(),
            "APPROVAL_TOKEN_KIND_MISMATCH"
        );
        assert_token_mismatch!(
            confirmation,
            "wrong-phrase".to_string(),
            "APPROVAL_TOKEN_CONFIRMATION_MISMATCH"
        );
        assert_token_mismatch!(
            token,
            "not-a-token".to_string(),
            "APPROVAL_TOKEN_FORMAT_INVALID"
        );
        assert_token_mismatch!(
            frozen_plan_id,
            "wrong-frozen-id".to_string(),
            "APPROVAL_TOKEN_FROZEN_PLAN_ID_MISMATCH"
        );
        assert_token_mismatch!(
            frozen_plan_hash,
            "0".repeat(64),
            "APPROVAL_TOKEN_FROZEN_PLAN_HASH_MISMATCH"
        );
        assert_token_mismatch!(
            frozen_artifact_sha256,
            "0".repeat(64),
            "APPROVAL_TOKEN_FROZEN_ARTIFACT_SHA256_MISMATCH"
        );
        assert_token_mismatch!(
            transaction_id,
            "wrong-transaction".to_string(),
            "APPROVAL_TOKEN_TRANSACTION_ID_MISMATCH"
        );
        assert_token_mismatch!(
            source_sha256,
            "0".repeat(64),
            "APPROVAL_TOKEN_SOURCE_SHA256_MISMATCH"
        );
        assert_token_mismatch!(
            source_size,
            approval.source_size + 1,
            "APPROVAL_TOKEN_SOURCE_SIZE_MISMATCH"
        );
        assert_token_mismatch!(
            export_version,
            approval.export_version + 1,
            "APPROVAL_TOKEN_EXPORT_VERSION_MISMATCH"
        );
        assert_token_mismatch!(
            supplemental_role_source_sha256,
            "0".repeat(64),
            "APPROVAL_TOKEN_ROLE_SOURCE_SHA256_MISMATCH"
        );
        assert_token_mismatch!(
            supplemental_memory_source_sha256,
            "0".repeat(64),
            "APPROVAL_TOKEN_MEMORY_SOURCE_SHA256_MISMATCH"
        );
        assert_token_mismatch!(
            authority_status,
            "wrong-status".to_string(),
            "APPROVAL_TOKEN_AUTHORITY_STATUS_MISMATCH"
        );
        assert_token_mismatch!(
            authority_revision_id,
            "wrong-revision".to_string(),
            "APPROVAL_TOKEN_AUTHORITY_REVISION_ID_MISMATCH"
        );
        assert_token_mismatch!(
            authority_revision_sha256,
            "0".repeat(64),
            "APPROVAL_TOKEN_AUTHORITY_REVISION_SHA256_MISMATCH"
        );
        assert_token_mismatch!(
            provenance_record_count,
            approval.provenance_record_count + 1,
            "APPROVAL_TOKEN_PROVENANCE_COUNT_MISMATCH"
        );
        assert_token_mismatch!(
            target_snapshot_sha256,
            "0".repeat(64),
            "APPROVAL_TOKEN_TARGET_SNAPSHOT_SHA256_MISMATCH"
        );
        assert_token_mismatch!(
            execution_phase,
            "R3-C".to_string(),
            "APPROVAL_TOKEN_EXECUTION_PHASE_MISMATCH"
        );
        assert_token_mismatch!(
            target_origin,
            "http://wrong.invalid".to_string(),
            "APPROVAL_TOKEN_TARGET_ORIGIN_MISMATCH"
        );
        assert_token_mismatch!(
            database_name,
            "WrongDB".to_string(),
            "APPROVAL_TOKEN_DATABASE_NAME_MISMATCH"
        );
        assert_token_mismatch!(
            schema_version,
            approval.schema_version + 1,
            "APPROVAL_TOKEN_SCHEMA_VERSION_MISMATCH"
        );
        let mut wrong_domains = approval.clone();
        wrong_domains.selected_domains.pop();
        assert_eq!(
            validate_restore_approval(&wrong_domains, &binding).unwrap_err(),
            "APPROVAL_TOKEN_SELECTED_DOMAINS_MISMATCH"
        );

        let mut invalid_bound_provenance = binding.clone();
        invalid_bound_provenance.provenance_digest = "0".repeat(64);
        assert_eq!(
            validate_restore_approval(&approval, &invalid_bound_provenance).unwrap_err(),
            "APPROVAL_BINDING_PROVENANCE_DIGEST_MISMATCH"
        );
        macro_rules! assert_invalid_bound_field {
            ($field:ident, $value:expr, $reason:literal) => {{
                let mut candidate = binding.clone();
                candidate.$field = $value;
                assert_eq!(
                    recovery_approval_binding_invalid_reason(&candidate),
                    Some($reason)
                );
            }};
        }
        assert_invalid_bound_field!(
            plan_hash,
            "invalid".to_string(),
            "APPROVAL_BINDING_PLAN_HASH_INVALID"
        );
        assert_invalid_bound_field!(
            plan_id,
            "wrong-plan".to_string(),
            "APPROVAL_BINDING_PLAN_ID_MISMATCH"
        );
        assert_invalid_bound_field!(
            transaction_id,
            "wrong-tx".to_string(),
            "APPROVAL_BINDING_TRANSACTION_ID_MISMATCH"
        );
        assert_invalid_bound_field!(
            frozen_plan_id,
            "wrong-frozen-id".to_string(),
            "APPROVAL_BINDING_FROZEN_PLAN_ID_MISMATCH"
        );
        assert_invalid_bound_field!(
            frozen_plan_hash,
            "0".repeat(64),
            "APPROVAL_BINDING_FROZEN_PLAN_HASH_MISMATCH"
        );
        assert_invalid_bound_field!(
            frozen_artifact_sha256,
            "0".repeat(64),
            "APPROVAL_BINDING_FROZEN_ARTIFACT_SHA256_MISMATCH"
        );
        assert_invalid_bound_field!(
            source_sha256,
            "0".repeat(64),
            "APPROVAL_BINDING_SOURCE_SHA256_MISMATCH"
        );
        assert_invalid_bound_field!(
            source_size,
            binding.source_size + 1,
            "APPROVAL_BINDING_SOURCE_SIZE_MISMATCH"
        );
        assert_invalid_bound_field!(
            export_version,
            binding.export_version + 1,
            "APPROVAL_BINDING_EXPORT_VERSION_MISMATCH"
        );
        assert_invalid_bound_field!(
            supplemental_role_source_sha256,
            "0".repeat(64),
            "APPROVAL_BINDING_ROLE_SOURCE_SHA256_MISMATCH"
        );
        assert_invalid_bound_field!(
            supplemental_memory_source_sha256,
            "0".repeat(64),
            "APPROVAL_BINDING_MEMORY_SOURCE_SHA256_MISMATCH"
        );
        assert_invalid_bound_field!(
            authority_type,
            "UNSUPPORTED_AUTHORITY".to_string(),
            "APPROVAL_BINDING_AUTHORITY_TYPE_MISMATCH"
        );
        assert_invalid_bound_field!(
            authority_status,
            "wrong-status".to_string(),
            "APPROVAL_BINDING_AUTHORITY_STATUS_MISMATCH"
        );
        assert_invalid_bound_field!(
            authority_revision_id,
            "wrong-revision".to_string(),
            "APPROVAL_BINDING_AUTHORITY_REVISION_ID_MISMATCH"
        );
        assert_invalid_bound_field!(
            authority_revision_sha256,
            "0".repeat(64),
            "APPROVAL_BINDING_AUTHORITY_REVISION_SHA256_MISMATCH"
        );
        assert_invalid_bound_field!(
            provenance_digest,
            "0".repeat(64),
            "APPROVAL_BINDING_PROVENANCE_DIGEST_MISMATCH"
        );
        assert_invalid_bound_field!(
            provenance_record_count,
            binding.provenance_record_count + 1,
            "APPROVAL_BINDING_PROVENANCE_COUNT_MISMATCH"
        );
        assert_invalid_bound_field!(
            target_snapshot_sha256,
            "invalid".to_string(),
            "APPROVAL_BINDING_TARGET_SNAPSHOT_SHA256_INVALID"
        );
        assert_invalid_bound_field!(
            execution_phase,
            "R3-C".to_string(),
            "APPROVAL_BINDING_EXECUTION_PHASE_MISMATCH"
        );
        assert_invalid_bound_field!(
            database_name,
            "WrongDB".to_string(),
            "APPROVAL_BINDING_DATABASE_NAME_MISMATCH"
        );
        assert_invalid_bound_field!(
            schema_version,
            binding.schema_version + 1,
            "APPROVAL_BINDING_SCHEMA_VERSION_MISMATCH"
        );
        assert_invalid_bound_field!(
            target_origin,
            "http://invalid.invalid".to_string(),
            "APPROVAL_BINDING_TARGET_ORIGIN_INVALID"
        );
        let mut invalid_selected_domains = binding.clone();
        invalid_selected_domains.selected_domains.pop();
        assert_eq!(
            recovery_approval_binding_invalid_reason(&invalid_selected_domains),
            Some("APPROVAL_BINDING_SELECTED_DOMAINS_MISMATCH")
        );
        assert_invalid_bound_field!(
            target_identity,
            "invalid-target".to_string(),
            "APPROVAL_BINDING_TARGET_IDENTITY_INVALID"
        );
        let mut expired = approval.clone();
        expired.expires_at = 0;
        assert_eq!(
            validate_restore_approval(&expired, &binding).unwrap_err(),
            "APPROVAL_TOKEN_EXPIRED"
        );

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .binding
            .target_identity
            .push_str("-synthetic-mismatch");
        assert_eq!(
            require_issued_recovery_approval(&approval, &binding, Some(false)).unwrap_err(),
            "APPROVAL_ISSUED_BINDING_TARGET_IDENTITY_MISMATCH"
        );
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .binding = binding.clone();

        persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &_checkpoint,
            &approval,
            &binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .expires_at += 1;
        assert_eq!(
            mark_issued_checkpoint_written(&approval, &binding, &root).unwrap_err(),
            "APPROVAL_TOKEN_EXPIRY_BINDING_MISMATCH"
        );
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .expires_at = approval.expires_at;

        assert_eq!(
            require_issued_recovery_approval(&approval, &binding, Some(true)).unwrap_err(),
            "APPROVAL_CHECKPOINT_NOT_MARKED_WRITTEN"
        );
        mark_issued_checkpoint_written(&approval, &binding, &root).unwrap();
        assert_eq!(
            require_issued_recovery_approval(&approval, &binding, Some(false)).unwrap_err(),
            "CHECKPOINT_STATE_TRANSITION_INVALID"
        );
        assert_eq!(
            mark_issued_checkpoint_written(&approval, &binding, &root).unwrap_err(),
            "CHECKPOINT_STATE_TRANSITION_INVALID"
        );
        assert!(consume_restore_approval_token(&token, &binding).is_ok());
        assert_eq!(
            consume_restore_approval_token(&token, &binding).unwrap_err(),
            "APPROVAL_TOKEN_ALREADY_CONSUMED"
        );

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&token);
        USED_RECOVERY_APPROVALS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap()
            .remove(&token);
        assert_eq!(
            require_issued_recovery_approval(&approval, &binding, Some(true)).unwrap_err(),
            "APPROVAL_TOKEN_NOT_ISSUED_HERE"
        );
        assert_eq!(
            consume_restore_approval_token(&token, &binding).unwrap_err(),
            "APPROVAL_TOKEN_NOT_ISSUED_HERE"
        );
        cleanup_owned_recovery_checkpoint_lifecycle(&root, &approval.lifecycle_id, &binding)
            .unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn checkpoint_mark_failure_cleans_only_the_owned_synthetic_checkpoint() {
        let root = synthetic_temp_root("checkpoint-mark-failure-order");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, checkpoint) = synthetic_issued_approval(&root);
        let token = approval.token.clone();

        persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .expires_at += 1;

        assert_eq!(
            finalize_checkpoint_lifecycle_for_approval(&approval, &binding, &root).unwrap_err(),
            "APPROVAL_TOKEN_EXPIRY_BINDING_MISMATCH"
        );
        assert!(!checkpoint_path(&root).exists());
        assert!(!checkpoint_lifecycle_intent_path(&root).exists());
        assert!(!checkpoint_lifecycle_ready_path(&root).exists());
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&token);

        let issue_request = RecoveryApprovalIssueRequest {
            kind: RECOVERY_APPROVAL_KIND.to_string(),
            confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
            entered_plan_id: binding.plan_id.clone(),
            entered_plan_hash: binding.plan_hash.clone(),
            plan: binding.clone(),
        };
        assert!(validate_recovery_approval_issue_request(&issue_request, &_host, &root).is_ok());
        let retry = issue_recovery_approval_inner(issue_request, &_host, &root).unwrap();
        assert_ne!(retry.lifecycle_id, approval.lifecycle_id);

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&token);
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&retry.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preapply_checkpoint_abort_consumes_token_and_removes_only_owned_artifacts() {
        let root = synthetic_temp_root("checkpoint-preapply-abort");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, host, checkpoint) = synthetic_issued_approval(&root);
        persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();
        finalize_checkpoint_lifecycle_for_approval(&approval, &binding, &root).unwrap();
        assert!(checkpoint_path(&root).is_file());
        assert!(checkpoint_lifecycle_ready_path(&root).is_file());
        assert!(!recovery_apply_window_matches(&binding.plan_id, None, None));

        let result = abort_recovery_checkpoint_before_apply_inner(
            approval.clone(),
            binding.clone(),
            &host,
            &root,
        )
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["aborted"], true);
        assert!(!checkpoint_path(&root).exists());
        assert!(!checkpoint_lifecycle_intent_path(&root).exists());
        assert!(!checkpoint_lifecycle_ready_path(&root).exists());
        assert!(!recovery_apply_window_matches(&binding.plan_id, None, None));
        assert_eq!(
            consume_restore_approval_token(&approval.token, &binding).unwrap_err(),
            "APPROVAL_TOKEN_ALREADY_CONSUMED"
        );

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        USED_RECOVERY_APPROVALS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn checkpoint_write_failure_cleans_reserved_intent_and_allows_retry() {
        let root = synthetic_temp_root("checkpoint-write-failure");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, host, checkpoint) = synthetic_issued_approval(&root);

        let error = persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |_path, _value| Err("SYNTHETIC_WRITE_FAILURE".to_string()),
        )
        .unwrap_err();
        assert_eq!(error, "SYNTHETIC_WRITE_FAILURE");
        assert!(!checkpoint_path(&root).exists());
        assert!(!checkpoint_lifecycle_intent_path(&root).exists());
        assert!(!checkpoint_lifecycle_ready_path(&root).exists());
        assert!(validate_recovery_approval_issue_request(
            &RecoveryApprovalIssueRequest {
                kind: RECOVERY_APPROVAL_KIND.to_string(),
                confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
                entered_plan_id: binding.plan_id.clone(),
                entered_plan_hash: binding.plan_hash.clone(),
                plan: binding.clone(),
            },
            &host,
            &root
        )
        .is_ok());

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn checkpoint_verification_failure_preserves_unowned_bytes_and_fails_closed() {
        let root = synthetic_temp_root("checkpoint-verify-failure");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, checkpoint) = synthetic_issued_approval(&root);
        let error = persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |path, expected| {
                let mut foreign = expected.clone();
                foreign.target_snapshot_sha256 = "b".repeat(64);
                foreign.integrity_sha256 = recovery_checkpoint_integrity_sha256(&foreign)?;
                write_new_json(path, &foreign)
            },
        )
        .unwrap_err();
        assert_eq!(error, "CHECKPOINT_DURABLE_VERIFY_FAILED_LIFECYCLE_PENDING");
        assert!(checkpoint_path(&root).is_file());
        assert!(checkpoint_lifecycle_intent_path(&root).is_file());
        assert!(!checkpoint_lifecycle_ready_path(&root).exists());
        let bytes = fs::read(checkpoint_path(&root)).unwrap();
        let persisted: RecoveryCheckpoint = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(persisted.target_snapshot_sha256, "b".repeat(64));
        assert_eq!(
            cleanup_owned_recovery_checkpoint_lifecycle(&root, &approval.lifecycle_id, &binding)
                .unwrap_err(),
            "CHECKPOINT_ARTIFACT_NOT_OWNED_BY_APPROVAL"
        );

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn foreign_checkpoint_is_never_overwritten_or_deleted() {
        let root = synthetic_temp_root("checkpoint-foreign-preserved");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, checkpoint) = synthetic_issued_approval(&root);
        let foreign_bytes = b"foreign-checkpoint-fixture";
        fs::write(checkpoint_path(&root), foreign_bytes).unwrap();

        assert_eq!(
            persist_checkpoint_lifecycle_artifacts_with(
                &root,
                &checkpoint,
                &approval,
                &binding,
                |path, value| write_new_json(path, value),
            )
            .unwrap_err(),
            "UNRESOLVED_RECOVERY_STATE_PRESENT"
        );
        assert_eq!(fs::read(checkpoint_path(&root)).unwrap(), foreign_bytes);
        assert!(!checkpoint_lifecycle_intent_path(&root).exists());

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn lifecycle_cleanup_is_approval_owned_and_never_deletes_foreign_checkpoint() {
        let root = synthetic_temp_root("checkpoint-owned-cleanup");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, _host, checkpoint) = synthetic_issued_approval(&root);
        persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();
        assert_eq!(
            cleanup_owned_recovery_checkpoint_lifecycle(&root, &"f".repeat(32), &binding)
                .unwrap_err(),
            "CHECKPOINT_ARTIFACT_NOT_OWNED_BY_APPROVAL"
        );
        assert!(checkpoint_path(&root).is_file());
        cleanup_owned_recovery_checkpoint_lifecycle(&root, &approval.lifecycle_id, &binding)
            .unwrap();
        assert!(!checkpoint_path(&root).exists());
        assert!(!checkpoint_lifecycle_intent_path(&root).exists());
        assert!(!checkpoint_lifecycle_ready_path(&root).exists());

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn crash_restart_and_stale_checkpoint_are_recognized_and_fail_closed() {
        let root = synthetic_temp_root("checkpoint-crash-restart");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, host, checkpoint) = synthetic_issued_approval(&root);
        persist_checkpoint_lifecycle_artifacts_with(
            &root,
            &checkpoint,
            &approval,
            &binding,
            |path, value| write_new_json(path, value),
        )
        .unwrap();
        let checkpoint_bytes = fs::read(checkpoint_path(&root)).unwrap();
        assert!(
            validate_checkpoint_lifecycle_files(&root, &checkpoint, &checkpoint_bytes, true)
                .is_ok()
        );

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        let policy = recovery_boot_policy_from_dir(&root);
        assert_eq!(policy.mode, RecoveryBootMode::Blocked);
        assert_eq!(policy.plan_id.as_deref(), Some(binding.plan_id.as_str()));
        assert_eq!(
            validate_recovery_approval_issue_request(
                &RecoveryApprovalIssueRequest {
                    kind: RECOVERY_APPROVAL_KIND.to_string(),
                    confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
                    entered_plan_id: binding.plan_id.clone(),
                    entered_plan_hash: binding.plan_hash.clone(),
                    plan: binding.clone(),
                },
                &host,
                &root,
            )
            .unwrap_err(),
            "APPROVAL_RECOVERY_STATE_BLOCKED"
        );
        assert_eq!(
            require_issued_recovery_approval(&approval, &binding, Some(true)).unwrap_err(),
            "APPROVAL_TOKEN_NOT_ISSUED_HERE"
        );
        fs::remove_dir_all(&root).unwrap();

        let intent_root = synthetic_temp_root("checkpoint-intent-only-crash");
        fs::create_dir_all(&intent_root).unwrap();
        let (intent_approval, intent_binding, intent_host, intent_checkpoint) =
            synthetic_issued_approval(&intent_root);
        let intent = make_recovery_checkpoint_lifecycle(
            &intent_checkpoint,
            &intent_approval.lifecycle_id,
            "RESERVED",
        )
        .unwrap();
        write_new_json(&checkpoint_lifecycle_intent_path(&intent_root), &intent).unwrap();
        let intent_only_policy = recovery_boot_policy_from_dir(&intent_root);
        assert_eq!(intent_only_policy.mode, RecoveryBootMode::Blocked);
        assert!(!checkpoint_path(&intent_root).exists());
        assert_eq!(
            validate_recovery_approval_issue_request(
                &RecoveryApprovalIssueRequest {
                    kind: RECOVERY_APPROVAL_KIND.to_string(),
                    confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
                    entered_plan_id: intent_binding.plan_id.clone(),
                    entered_plan_hash: intent_binding.plan_hash.clone(),
                    plan: intent_binding,
                },
                &intent_host,
                &intent_root,
            )
            .unwrap_err(),
            "APPROVAL_RECOVERY_STATE_BLOCKED"
        );
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&intent_approval.token);
        fs::remove_dir_all(&intent_root).unwrap();

        let stale_root = synthetic_temp_root("checkpoint-stale-no-lifecycle");
        fs::create_dir_all(&stale_root).unwrap();
        let stale = synthetic_recovery_checkpoint();
        write_new_json(&checkpoint_path(&stale_root), &stale).unwrap();
        assert_eq!(
            recovery_boot_policy_from_dir(&stale_root).mode,
            RecoveryBootMode::Blocked
        );
        fs::remove_dir_all(&stale_root).unwrap();
    }

    #[test]
    fn apply_window_requires_ready_checkpoint_lifecycle() {
        let root = synthetic_temp_root("checkpoint-apply-before-ready");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, host, checkpoint) = synthetic_issued_approval(&root);
        let intent =
            make_recovery_checkpoint_lifecycle(&checkpoint, &approval.lifecycle_id, "RESERVED")
                .unwrap();
        write_new_json(&checkpoint_lifecycle_intent_path(&root), &intent).unwrap();
        write_new_json(&checkpoint_path(&root), &checkpoint).unwrap();

        assert_eq!(
            open_recovery_apply_window_inner(approval.clone(), binding.clone(), &host, &root)
                .unwrap_err(),
            "RECOVERY_CHECKPOINT_LIFECYCLE_NOT_READY"
        );
        assert!(!recovery_apply_window_matches(&binding.plan_id, None, None));
        assert!(require_issued_recovery_approval(&approval, &binding, Some(false)).is_ok());

        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn approval_issue_validation_returns_safe_stage_specific_reasons() {
        let root = synthetic_temp_root("approval-denial-reasons");
        fs::create_dir_all(&root).unwrap();
        let checkpoint = synthetic_recovery_checkpoint();
        let binding = approval_binding_from_checkpoint(&checkpoint).unwrap();
        let host = RecoveryOnlyHostState {
            target_identity: checkpoint.target_identity.clone(),
            target_origin: checkpoint.target_origin.clone(),
            active_quarantined: true,
            reconstruction_dry_run_only: false,
        };
        let valid_request = || RecoveryApprovalIssueRequest {
            kind: RECOVERY_APPROVAL_KIND.to_string(),
            confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
            entered_plan_id: binding.plan_id.clone(),
            entered_plan_hash: binding.plan_hash.clone(),
            plan: binding.clone(),
        };

        let mut wrong_plan = valid_request();
        wrong_plan.entered_plan_id = "r3b3:wrong".to_string();
        assert_eq!(
            validate_recovery_approval_issue_request(&wrong_plan, &host, &root).unwrap_err(),
            "APPROVAL_PLAN_MISMATCH"
        );

        let mut wrong_hash = valid_request();
        wrong_hash.entered_plan_hash = "0".repeat(64);
        assert_eq!(
            validate_recovery_approval_issue_request(&wrong_hash, &host, &root).unwrap_err(),
            "APPROVAL_HASH_MISMATCH"
        );

        let mut wrong_phrase = valid_request();
        wrong_phrase.confirmation = "not-the-confirmation".to_string();
        assert_eq!(
            validate_recovery_approval_issue_request(&wrong_phrase, &host, &root).unwrap_err(),
            "APPROVAL_CONFIRMATION_PHRASE_MISMATCH"
        );

        let mut wrong_authority = valid_request();
        wrong_authority.plan.authority_type = "UNSUPPORTED_AUTHORITY".to_string();
        assert_eq!(
            validate_recovery_approval_issue_request(&wrong_authority, &host, &root).unwrap_err(),
            "APPROVAL_BINDING_AUTHORITY_TYPE_MISMATCH"
        );

        let wrong_host = RecoveryOnlyHostState {
            target_identity: "com.internalbeyond.desktop|canonical-inno|C:\\Other|1.0.6|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            target_origin: host.target_origin.clone(),
            active_quarantined: true,
            reconstruction_dry_run_only: false,
        };
        assert_eq!(
            validate_recovery_approval_issue_request(&valid_request(), &wrong_host, &root)
                .unwrap_err(),
            "APPROVAL_TARGET_BINDING_MISMATCH"
        );

        let issued = issue_recovery_approval_inner(valid_request(), &host, &root).unwrap();
        assert_eq!(
            validate_recovery_approval_slot(&binding).unwrap_err(),
            "APPROVAL_DUPLICATE_ISSUANCE"
        );
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&issued.token);

        fs::write(checkpoint_path(&root), b"synthetic existing marker").unwrap();
        assert_eq!(
            validate_recovery_approval_issue_request(&valid_request(), &host, &root).unwrap_err(),
            "APPROVAL_RECOVERY_STATE_BLOCKED"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_target_identity_binds_declared_payload_content_and_rejects_escape_paths() {
        let root = synthetic_temp_root("recovery-content-identity");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Recovery.html"), b"recovery-shell-v1").unwrap();
        fs::write(root.join("internalbeyond-host.exe"), b"host-v1").unwrap();
        let declared = BTreeSet::from([
            "Recovery.html".to_string(),
            "internalbeyond-host.exe".to_string(),
        ]);
        let first = recovery_payload_content_identity(&root, &declared).unwrap();
        assert!(is_sha256(&first));
        assert_eq!(
            first,
            recovery_payload_content_identity(&root, &declared).unwrap()
        );
        fs::write(root.join("Recovery.html"), b"recovery-shell-v2").unwrap();
        let changed = recovery_payload_content_identity(&root, &declared).unwrap();
        assert_ne!(first, changed);
        let escape = BTreeSet::from(["../outside.bin".to_string()]);
        assert!(recovery_payload_content_identity(&root, &escape).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn native_approval_requires_exact_plan_binding_and_checkpoint_precedes_window() {
        assert!(!PRODUCTION_RESTORE_ENABLED);
        let root = synthetic_temp_root("recovery-native-approval");
        fs::create_dir_all(&root).unwrap();
        let mut checkpoint = synthetic_recovery_checkpoint();
        let binding = approval_binding_from_checkpoint(&checkpoint).unwrap();
        let host = RecoveryOnlyHostState {
            target_identity: checkpoint.target_identity.clone(),
            target_origin: checkpoint.target_origin.clone(),
            active_quarantined: true,
            reconstruction_dry_run_only: false,
        };
        let issue = |plan_id: String, plan_hash: String| RecoveryApprovalIssueRequest {
            kind: RECOVERY_APPROVAL_KIND.to_string(),
            confirmation: RECOVERY_APPROVAL_PHRASE.to_string(),
            entered_plan_id: plan_id,
            entered_plan_hash: plan_hash,
            plan: binding.clone(),
        };
        assert!(issue_recovery_approval_inner(
            issue("r3b3:wrong".to_string(), binding.plan_hash.clone()),
            &host,
            &root
        )
        .is_err());
        assert!(issue_recovery_approval_inner(
            issue(binding.plan_id.clone(), "0".repeat(64)),
            &host,
            &root
        )
        .is_err());
        assert!(!checkpoint_path(&root).exists());

        let approval = issue_recovery_approval_inner(
            issue(binding.plan_id.clone(), binding.plan_hash.clone()),
            &host,
            &root,
        )
        .unwrap();
        checkpoint.lifecycle_id = approval.lifecycle_id.clone();
        checkpoint.integrity_sha256 = recovery_checkpoint_integrity_sha256(&checkpoint).unwrap();
        assert_eq!(approval.kind, RECOVERY_APPROVAL_KIND);
        assert!(validate_restore_approval(&approval, &binding).is_ok());

        let mut fabricated_test_approval = approval.clone();
        fabricated_test_approval.kind = "SYNTHETIC_TEST_APPROVAL".to_string();
        assert!(write_recovery_checkpoint_inner(
            checkpoint.clone(),
            fabricated_test_approval,
            &host,
            &root
        )
        .is_err());
        assert!(!checkpoint_path(&root).exists());

        write_recovery_checkpoint_inner(checkpoint.clone(), approval.clone(), &host, &root)
            .unwrap();
        assert!(checkpoint_path(&root).is_file());
        assert!(!recovery_apply_window_matches(&binding.plan_id, None, None));
        assert!(require_issued_recovery_approval(&approval, &binding, Some(true)).is_ok());
        issued_recovery_approval_registry()
            .lock()
            .unwrap()
            .remove(&approval.token);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn production_apply_window_is_recovery_only_plan_bound_single_use_and_volatile() {
        assert!(!PRODUCTION_RESTORE_ENABLED);
        assert!(!recovery_apply_window_matches("missing", None, None));
        let root = synthetic_temp_root("recovery-apply-window");
        fs::create_dir_all(&root).unwrap();
        let (approval, binding, host, _checkpoint) = synthetic_apply_window_approval(&root);
        let token = approval.token.clone();
        assert!(checkpoint_path(&root).exists());
        let wrong_host = RecoveryOnlyHostState {
            target_identity:
                "com.internalbeyond.desktop|canonical-inno|C:\\Other\\Root|1.0.6|other".to_string(),
            target_origin: host.target_origin.clone(),
            active_quarantined: true,
            reconstruction_dry_run_only: false,
        };
        assert!(open_recovery_apply_window_inner(
            approval.clone(),
            binding.clone(),
            &wrong_host,
            &root
        )
        .is_err());
        let opened =
            open_recovery_apply_window_inner(approval.clone(), binding.clone(), &host, &root)
                .unwrap();
        assert_eq!(opened["ok"], true);
        assert!(recovery_apply_window_matches(
            &binding.plan_id,
            Some(&token),
            Some(&binding)
        ));
        assert!(
            open_recovery_apply_window_inner(approval.clone(), binding.clone(), &host, &root)
                .is_err()
        );
        close_recovery_apply_window_inner(
            RecoveryApplyWindowCloseRequest {
                plan_id: binding.plan_id.clone(),
                token: token.clone(),
            },
            &host,
        )
        .unwrap();
        assert!(!recovery_apply_window_matches(
            &binding.plan_id,
            Some(&token),
            Some(&binding)
        ));
        assert!(checkpoint_path(&root).exists());
        assert!(!verified_marker_path(&root).exists());
        assert!(!consumed_marker_path(&root).exists());
        assert_eq!(
            consume_restore_approval_token(&token, &binding).unwrap_err(),
            "APPROVAL_TOKEN_ALREADY_CONSUMED"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn checkpoint_integrity_detects_tampering_and_native_approval_is_single_use() {
        let checkpoint = synthetic_recovery_checkpoint();
        assert!(is_sha256(&checkpoint.integrity_sha256));
        let mut corrupt = checkpoint.clone();
        corrupt.target_snapshot_sha256 = "b".repeat(64);
        assert_eq!(
            validate_recovery_checkpoint(&corrupt).unwrap_err(),
            "RECOVERY_CHECKPOINT_INTEGRITY_INVALID"
        );
        let root = synthetic_temp_root("checkpoint-approval-replay");
        fs::create_dir_all(&root).unwrap();
        let (_approval, binding, _host, _) = synthetic_apply_window_approval(&root);
        assert!(binding.plan_id.starts_with("r3b3:"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn checkpoint_type_rejects_secret_payload_fields() {
        let value = serde_json::to_value(synthetic_recovery_checkpoint()).unwrap();
        let mut object = value.as_object().unwrap().clone();
        object.insert(
            "apiKey".to_string(),
            serde_json::Value::String("must-not-persist".to_string()),
        );
        assert!(
            serde_json::from_value::<RecoveryCheckpoint>(serde_json::Value::Object(object))
                .is_err()
        );
        assert!(serde_json::to_string(&synthetic_recovery_checkpoint())
            .unwrap()
            .find("must-not-persist")
            .is_none());
    }

    #[test]
    fn first_boot_marker_is_one_shot_and_active_quarantine_persists() {
        let root = synthetic_temp_root("recovery-boot-policy");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            recovery_boot_policy_from_dir(&root).mode,
            RecoveryBootMode::Normal
        );
        let checkpoint = synthetic_recovery_checkpoint();
        synthetic_write_checkpoint_lifecycle_files(&root, &checkpoint);
        assert_eq!(
            recovery_boot_policy_from_dir(&root).mode,
            RecoveryBootMode::Blocked
        );
        let verified = RecoveryCheckpointVerifiedMarker {
            schema: "internalbeyond.recovery-checkpoint-verified".to_string(),
            version: 1,
            plan_id: checkpoint.plan_id.clone(),
            verified_at: "unix-ms:1700000000500".to_string(),
        };
        write_new_json(&verified_marker_path(&root), &verified).unwrap();
        let pending = recovery_boot_policy_from_dir(&root);
        assert_eq!(pending.mode, RecoveryBootMode::FirstBootPending);
        assert!(pending.suppress_services() && pending.active_quarantined());

        let consumed = RecoveryFirstBootConsumed {
            schema: RECOVERY_CONSUMED_SCHEMA.to_string(),
            version: 1,
            plan_id: checkpoint.plan_id.clone(),
            consumed_at: "unix-ms:1700000001000".to_string(),
        };
        write_new_json(&consumed_marker_path(&root), &consumed).unwrap();
        let after_first_boot = recovery_boot_policy_from_dir(&root);
        assert_eq!(after_first_boot.mode, RecoveryBootMode::ActiveQuarantine);
        assert!(!after_first_boot.first_boot_pending());
        assert!(after_first_boot.suppress_services() && after_first_boot.active_quarantined());

        let duplicate = write_new_json(&consumed_marker_path(&root), &consumed);
        assert!(
            duplicate.is_err(),
            "the one-time consumed marker must not be overwritten"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_or_orphaned_recovery_marker_fails_closed() {
        let root = synthetic_temp_root("recovery-boot-corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(consumed_marker_path(&root), b"{}").unwrap();
        let policy = recovery_boot_policy_from_dir(&root);
        assert_eq!(policy.mode, RecoveryBootMode::Blocked);
        assert!(policy.suppress_services() && policy.active_quarantined());
        fs::remove_dir_all(&root).unwrap();
    }
}
