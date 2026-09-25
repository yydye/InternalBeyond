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

    for directory in ["assets", "active", "apps", "game"] {
        let source = product_root.join(directory);
        let destination = stage.join(directory);
        if !destination.exists() {
            link_directory(&source, &destination);
        }
    }

    for entrypoint in html_entrypoints {
        println!(
            "cargo:rerun-if-changed={}",
            product_root.join(entrypoint).display()
        );
    }
    for directory in ["assets", "active", "apps", "game"] {
        println!(
            "cargo:rerun-if-changed={}",
            product_root.join(directory).display()
        );
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
