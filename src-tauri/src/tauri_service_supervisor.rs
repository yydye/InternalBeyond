use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointProbe {
    Healthy,
    Offline,
    OccupiedUnknown,
    UnhealthyIdentity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartAction {
    Reuse,
    Spawn,
    Wait,
    FailClosed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeState {
    HostStarting,
    HostReady,
    Degraded,
}

pub fn probe_reason_code(probe: EndpointProbe) -> Option<&'static str> {
    match probe {
        EndpointProbe::Healthy => None,
        EndpointProbe::Offline => Some("home-node-offline"),
        EndpointProbe::OccupiedUnknown => Some("home-node-port-conflict"),
        EndpointProbe::UnhealthyIdentity => Some("home-node-not-serving"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeVerdict {
    pub state: RuntimeState,
    pub host_ready: bool,
    pub home_node_ready: bool,
    pub degraded: bool,
    pub canonical_writes_ready: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostServicePaths {
    pub node: PathBuf,
    pub launcher: PathBuf,
    pub runner: PathBuf,
    pub home_node: PathBuf,
    pub static_server: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub struct HomeNodeStartGate {
    spawn_attempted: bool,
}

impl HomeNodeStartGate {
    pub fn plan(&mut self, probe: EndpointProbe) -> StartAction {
        match probe {
            EndpointProbe::Healthy => StartAction::Reuse,
            EndpointProbe::Offline if !self.spawn_attempted => {
                self.spawn_attempted = true;
                StartAction::Spawn
            }
            EndpointProbe::Offline => StartAction::Wait,
            EndpointProbe::OccupiedUnknown | EndpointProbe::UnhealthyIdentity => {
                StartAction::FailClosed
            }
        }
    }

    #[cfg(test)]
    pub fn spawn_attempted(&self) -> bool {
        self.spawn_attempted
    }
}

pub fn runtime_verdict(
    host_ready: bool,
    launcher_ready: bool,
    home_node_ready: bool,
    optional_service_failed: bool,
) -> RuntimeVerdict {
    let degraded = host_ready && (!launcher_ready || !home_node_ready || optional_service_failed);
    let state = if !host_ready {
        RuntimeState::HostStarting
    } else if degraded {
        RuntimeState::Degraded
    } else {
        RuntimeState::HostReady
    };
    RuntimeVerdict {
        state,
        host_ready,
        home_node_ready,
        degraded,
        canonical_writes_ready: home_node_ready,
    }
}

pub fn owned_by_current_host(
    pid: u32,
    spawned_by_host: bool,
    recorded_session: &str,
    current_session: &str,
) -> bool {
    pid > 0 && spawned_by_host && !current_session.is_empty() && recorded_session == current_session
}

pub fn safe_fallback_pid(
    recorded_pid: u32,
    actual_pid: u32,
    identity_matches: bool,
    session_matches: bool,
) -> bool {
    recorded_pid > 0 && recorded_pid == actual_pid && identity_matches && session_matches
}

pub fn service_paths(root: &Path) -> HostServicePaths {
    HostServicePaths {
        node: root.join("runtime").join("node").join("node.exe"),
        launcher: root.join("runtime").join("launch-internal-beyond.js"),
        runner: root.join("runtime").join("local-services-runner.js"),
        home_node: root.join("services").join("home-node-service.js"),
        static_server: root.join("services").join("internal-beyond-server.js"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn cold_start_spawns_once_then_waits_for_home_node_health() {
        let mut gate = HomeNodeStartGate::default();
        assert_eq!(gate.plan(EndpointProbe::Offline), StartAction::Spawn);
        assert_eq!(gate.plan(EndpointProbe::Offline), StartAction::Wait);
        assert_eq!(gate.plan(EndpointProbe::Healthy), StartAction::Reuse);
        assert!(gate.spawn_attempted());
        let verdict = runtime_verdict(true, true, true, false);
        assert_eq!(verdict.state, RuntimeState::HostReady);
        assert!(verdict.canonical_writes_ready);
    }

    #[test]
    fn already_running_home_node_is_reused_without_spawn() {
        let mut gate = HomeNodeStartGate::default();
        assert_eq!(gate.plan(EndpointProbe::Healthy), StartAction::Reuse);
        assert!(!gate.spawn_attempted());
    }

    #[test]
    fn unknown_listener_fails_closed_without_spawn_or_kill() {
        let mut gate = HomeNodeStartGate::default();
        assert_eq!(
            gate.plan(EndpointProbe::OccupiedUnknown),
            StartAction::FailClosed
        );
        assert_eq!(
            probe_reason_code(EndpointProbe::OccupiedUnknown),
            Some("home-node-port-conflict")
        );
        assert!(!gate.spawn_attempted());
        assert!(!safe_fallback_pid(7, 7, false, true));
    }

    #[test]
    fn child_crash_before_health_is_degraded() {
        let verdict = runtime_verdict(true, false, false, false);
        assert_eq!(verdict.state, RuntimeState::Degraded);
        assert!(!verdict.canonical_writes_ready);
    }

    #[test]
    fn readiness_timeout_keeps_ui_available_but_degraded() {
        let verdict = runtime_verdict(true, false, false, false);
        assert!(verdict.host_ready);
        assert!(verdict.degraded);
    }

    #[test]
    fn optional_service_failure_does_not_block_home_node_or_ui() {
        let verdict = runtime_verdict(true, true, true, true);
        assert!(verdict.host_ready);
        assert!(verdict.home_node_ready);
        assert!(verdict.degraded);
        assert!(verdict.canonical_writes_ready);
    }

    #[test]
    fn normal_exit_requires_graceful_request_for_current_owned_child() {
        assert!(owned_by_current_host(42, true, "session-a", "session-a"));
        assert!(safe_fallback_pid(42, 42, true, true));
    }

    #[test]
    fn external_service_is_never_a_shutdown_target() {
        assert!(!owned_by_current_host(42, false, "session-a", "session-a"));
        assert!(!owned_by_current_host(
            42,
            true,
            "session-old",
            "session-new"
        ));
        assert!(!safe_fallback_pid(42, 42, true, false));
    }

    #[test]
    fn restart_reuses_healthy_orphan_and_does_not_duplicate_spawn() {
        let mut gate = HomeNodeStartGate::default();
        assert_eq!(gate.plan(EndpointProbe::Healthy), StartAction::Reuse);
        assert_eq!(gate.plan(EndpointProbe::Healthy), StartAction::Reuse);
        assert!(!gate.spawn_attempted());
    }

    #[test]
    fn development_and_packaged_paths_are_root_relative() {
        let dev = service_paths(Path::new(r"C:\work\InternalBeyond"));
        let installed = service_paths(Path::new(
            r"C:\InternalBeyondFixture\path-5a9f7a089a",
        ));
        assert!(dev.home_node.ends_with(r"services\home-node-service.js"));
        assert!(installed.node.ends_with(r"runtime\node\node.exe"));
        assert_ne!(dev.home_node, installed.home_node);
        assert!(!dev
            .home_node
            .to_string_lossy()
            .contains("E:\\InternalBeyond-main"));
    }

    #[test]
    fn canonical_memory_write_gate_follows_home_node_readiness() {
        let offline = runtime_verdict(true, true, false, false);
        let ready = runtime_verdict(true, true, true, false);
        assert!(!offline.canonical_writes_ready);
        assert!(ready.canonical_writes_ready);
    }
}
