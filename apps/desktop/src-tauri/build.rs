fn main() {
    use sha2::{Digest, Sha256};
    println!("cargo:rerun-if-env-changed=SITE_FACTORY_PACKAGE_MANIFEST");
    let target = match std::env::var("TARGET").unwrap().as_str() {
        "x86_64-pc-windows-msvc" => "win32-x64",
        "aarch64-apple-darwin" => "darwin-arm64",
        "x86_64-apple-darwin" => "darwin-x64",
        _ => "unsupported",
    };
    let digest = if let Some(path) = std::env::var_os("SITE_FACTORY_PACKAGE_MANIFEST") {
        let path = std::path::PathBuf::from(path);
        assert!(
            path.is_absolute(),
            "Package manifest build input must be absolute"
        );
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = std::fs::read(path).expect("finalized runtime manifest");
        assert!(
            bytes.len() <= 16 * 1024 * 1024,
            "Runtime manifest too large"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).expect("runtime manifest JSON");
        assert_eq!(value["format"], 1);
        assert_eq!(value["target"], target);
        assert_eq!(value["node"], "24.21.0");
        assert_eq!(value["playwright"], "1.64.1");
        format!("{:x}", Sha256::digest(bytes))
    } else {
        assert_ne!(std::env::var("PROFILE").as_deref(), Ok("release"), "Release requires finalized SITE_FACTORY_PACKAGE_MANIFEST; adjacent runtime checksums are not a trust anchor");
        String::new()
    };
    let source = format!("pub const MANIFEST_SHA256: &str = {digest:?};\npub const PACKAGE_TARGET: &str = {target:?};\npub const MANIFEST_FORMAT: u8 = 1;\n");
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("runtime_anchor.rs"),
        source,
    )
    .unwrap();
    let mut attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "dispatch",
            "model_settings",
            "open_remote_preview",
            "managed_worker",
            "archive_operation",
        ]));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Link the Common Controls v6 manifest into unit-test harnesses as well as the app.
        // Otherwise the test harness cannot resolve TaskDialogIndirect on Windows.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::try_build(attributes).expect("build desktop permissions");
}
