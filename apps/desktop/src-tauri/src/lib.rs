mod archive;
mod commands;
mod managed;
mod remote_preview;
mod secrets;
mod worker;
mod runtime_package;
use tauri::Manager;
/// Early non-GUI support commands. They never build Tauri or initialize OS credentials.
pub fn package_cli(command:&str)->Result<serde_json::Value,commands::AppError>{
    if command=="--package-info" {return Ok(serde_json::json!({"manifestSha256":runtime_package::MANIFEST_SHA256,"target":runtime_package::PACKAGE_TARGET,"format":runtime_package::MANIFEST_FORMAT}));}
    if command!="--package-smoke"{return Err(commands::AppError::new("Unknown package diagnostic"));}
    let executable=std::env::current_exe()?;let directory=executable.parent().ok_or_else(||commands::AppError::new("Missing executable directory"))?;
    #[cfg(target_os="macos")]
    let resources=directory.parent().ok_or_else(||commands::AppError::new("Missing app bundle"))?.join("Resources");
    #[cfg(not(target_os="macos"))]
    let resources=directory.to_path_buf();
    worker::package_smoke(&resources)
}
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_local_data_dir()?;
            let config = worker::LaunchConfig::resolve(&app.path().resource_dir()?, data)?;
            app.manage(std::sync::Mutex::new(worker::Worker::lazy(config)?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::dispatch,
            commands::model_settings,
            commands::managed_worker,
            archive::archive_operation,
            remote_preview::open_remote_preview
        ])
        .build(tauri::generate_context!())
        .expect("start desktop");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = app.try_state::<std::sync::Mutex<worker::Worker>>() {
                if let Ok(mut worker) = state.lock() {
                    worker.shutdown();
                }
            }
        }
    });
}
