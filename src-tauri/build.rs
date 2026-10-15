use std::{
    env, fs,
    path::{Path, PathBuf},
};

#[cfg(windows)]
fn link_directory(source: &Path, destination: &Path) {
    let status = std::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            destination.to_string_lossy().as_ref(),
            source.to_string_lossy().as_ref(),
        ])
        .status()
        .unwrap_or_else(|error| panic!("cannot create frontend directory junction: {error}"));
    assert!(
        status.success(),
        "cannot create frontend directory junction {} -> {}",
        destination.display(),
        source.display()
    );
}

#[cfg(not(windows))]
fn link_directory(source: &Path, destination: &Path) {
    std::os::unix::fs::symlink(source, destination).unwrap_or_else(|error| {
        panic!(
            "cannot create frontend directory symlink {} -> {}: {error}",
            destination.display(),
            source.display()
        )
    });
}

fn prepare_frontend_dist(product_root: &Path) {
    // Tauri's frontendDist directory is the URL root. Keep the existing
    // relative asset URLs intact by exposing the product tree beneath one
    // directory, without copying a second set of frontend bytes.
    let stage = product_root.join(".tauri-frontend");
    fs::create_dir_all(&stage)
        .unwrap_or_else(|error| panic!("cannot create {}: {error}", stage.display()));

    let html_entrypoints = ["InternalBeyond.html", "Recovery.html"];
    for entrypoint in html_entrypoints {
        let html_source = product_root.join(entrypoint);
        let html_destination = stage.join(entrypoint);
        if entrypoint == "InternalBeyond.html" && html_destination.exists() {
            // The staged entrypoint may still be linked to an older source inode
            // after an editor replaces InternalBeyond.html atomically.
            fs::remove_file(&html_destination).unwrap_or_else(|error| {
                panic!(
                    "cannot refresh frontend entrypoint {}: {error}",
                    html_destination.display()
                )
            });
        }
        if !html_destination.exists() {
            fs::hard_link(&html_source, &html_destination).unwrap_or_else(|error| {
                panic!(
                    "cannot link frontend entrypoint {} -> {}: {error}",
                    html_destination.display(),
                    html_source.display()
                )
            });
        }
    }

    // Keep the runtime VERSION endpoint beside the staged HTML so startup
    // playback can compare major versions without waiting for a service probe.
    let version_source = product_root.join("VERSION");
    let version_destination = stage.join("VERSION");
    fs::copy(&version_source, &version_destination).unwrap_or_else(|error| {
        panic!(
            "cannot stage frontend version {} -> {}: {error}",
            version_source.display(),
            version_destination.display()
        )
    });

    /* Tauri's frontendDist is the URL root: anything the WebView fetches with a
    relative URL has to be exposed here. "docs/guide" is not reader documentation
    — it holds the Beginner Guide screenshots that guide-beginner.js loads as
    `docs/guide/shots/<id>.png`. Leaving it out makes the production host resolve
    http://tauri.localhost/docs/guide/shots/<id>.png to a 404 and the guide falls
    back to "这张图暂时打不开", while dev mode hides the bug because it serves the
    whole repository over HTTP.

    Only docs/guide is exposed on purpose: the rest of docs/ is internal design
    material (architecture, contracts, history, reports and 116 root .md files)
    and must not be embedded into a shipped build.

    Paths are built one component at a time on purpose: joining a literal
    "docs/guide" would keep the forward slash, and cmd.exe reads the "/guide" in
    `mklink /J <dest> <src>` as a switch ("Invalid switch - guide"). */
    let directories: [&[&str]; 5] = [
        &["assets"],
        &["active"],
        &["apps"],
        &["game"],
        &["docs", "guide"],
    ];
    for directory in directories {
        let source = directory
            .iter()
            .fold(product_root.to_path_buf(), |path, part| path.join(part));
        let destination = directory
            .iter()
            .fold(stage.clone(), |path, part| path.join(part));
        if !destination.exists() {
            /* A nested entry such as docs/guide needs its parent to exist before
            mklink /J can create the junction. */
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .unwrap_or_else(|error| panic!("cannot create {}: {error}", parent.display()));
            }
            link_directory(&source, &destination);
        }
    }

    let startup_video = "Video/08e2b1dc2b734d4fafae30c3fb9f2f01 (1).mp4";
    let video_source = product_root.join(startup_video);
    let video_destination = stage.join(startup_video);
    let video_parent = video_destination.parent().expect("startup video has a parent");
    fs::create_dir_all(video_parent)
        .unwrap_or_else(|error| panic!("cannot create {}: {error}", video_parent.display()));
    fs::copy(&video_source, &video_destination).unwrap_or_else(|error| {
        panic!(
            "cannot stage startup video {} -> {}: {error}",
            video_source.display(),
            video_destination.display()
        )
    });
    println!("cargo:rerun-if-changed={}", video_source.display());

    for entrypoint in html_entrypoints {
        println!(
            "cargo:rerun-if-changed={}",
            product_root.join(entrypoint).display()
        );
    }
    for directory in directories {
        let path = directory
            .iter()
            .fold(product_root.to_path_buf(), |path, part| path.join(part));
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn main() {
    /* VERSION is the product authority used by the existing Web Core, launcher
    and installer. Cargo/Tauri metadata is deliberately only a build-time
    mirror; fail before compiling if it drifts. */
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let product_root = manifest_dir
        .parent()
        .expect("src-tauri must live below the product root");
    prepare_frontend_dist(product_root);

    let version_file = product_root.join("VERSION");
    let canonical = fs::read_to_string(&version_file)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", version_file.display()))
        .trim()
        .to_owned();
    let cargo_version = env!("CARGO_PKG_VERSION");
    if canonical != cargo_version {
        panic!(
            "Tauri package version drift: VERSION={canonical}, CARGO_PKG_VERSION={cargo_version}"
        );
    }
    println!("cargo:rerun-if-changed={}", version_file.display());
    tauri_build::build()
}
