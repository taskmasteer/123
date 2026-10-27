fn main() {
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["dispatch", "model_settings", "open_remote_preview"]));
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
