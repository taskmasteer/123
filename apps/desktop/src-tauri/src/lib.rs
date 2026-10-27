mod commands;
mod managed;
mod remote_preview;
mod secrets;
mod worker;
use tauri::Manager;
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_local_data_dir()?;
            let config = worker::LaunchConfig::resolve(&app.path().resource_dir()?, data)?;
            app.manage(std::sync::Mutex::new(worker::Worker::new(config)?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::dispatch,
            commands::model_settings,
            commands::managed_worker,
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
