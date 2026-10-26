use crate::worker::Worker;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopRequest {
    pub id: String,
    pub version: u32,
    pub method: String,
    pub params: Value,
}
#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_INPUT".into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self {
            code: "NEEDS_ATTENTION".into(),
            message: e.to_string(),
        }
    }
}
pub fn validate(request: &DesktopRequest) -> Result<(), AppError> {
    let invalid = || AppError::new("Unsupported or malformed desktop request");
    if request.version != 1
        || request.id.is_empty()
        || request.id.len() > 64
        || !request
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(invalid());
    }
    let allowed: &[&str] = match request.method.as_str() {
        "site.list" | "device.status" | "catalog.list" => &[],
        "site.create" => &["domain", "about", "referenceId"],
        "job.status" | "job.retry" | "edit.list" | "chat.list" => &["siteId"],
        "edit.request" => &["siteId", "instruction", "expectedRevision", "candidateId"],
        "edit.accept" => &["siteId", "candidateId", "expectedRevision"],
        "edit.reject" => &["siteId", "candidateId"],
        "site.publish" => &["siteId", "expectedRevision"],
        "preview.open" => &["siteId", "revisionId"],
        "preview.screenshot" => &["siteId", "revisionId", "width", "candidateId"],
        "catalog.style.update" => &["id", "enabled"],
        "catalog.reference.update" => &["id", "description"],
        _ => return Err(invalid()),
    };
    let params = request.params.as_object().ok_or_else(invalid)?;
    if params.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid());
    }
    let text = |key: &str, max: usize| {
        params
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| !v.trim().is_empty() && v.len() <= max)
    };
    let uuid = |key: &str| {
        params.get(key).and_then(Value::as_str).is_some_and(|v| {
            v.len() == 36
                && v.bytes().enumerate().all(|(i, c)| {
                    if [8, 13, 18, 23].contains(&i) {
                        c == b'-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                })
        })
    };
    match request.method.as_str() {
        "site.create" => {
            if !text("domain", 253)
                || params
                    .get("about")
                    .is_some_and(|v| !v.as_str().is_some_and(|s| s.len() <= 32000))
                || params
                    .get("referenceId")
                    .is_some_and(|_| !text("referenceId", 100))
            {
                return Err(invalid());
            }
        }
        "job.status" | "job.retry" | "edit.list" | "chat.list" => {
            if !uuid("siteId") {
                return Err(invalid());
            }
        }
        "edit.request" | "edit.accept" | "edit.reject" | "site.publish" => {
            if !uuid("siteId")
                || (request.method != "edit.reject"
                    && !params
                        .get("expectedRevision")
                        .and_then(Value::as_u64)
                        .is_some_and(|v| v <= 9_007_199_254_740_991))
                || (matches!(request.method.as_str(), "edit.accept" | "edit.reject")
                    && !uuid("candidateId"))
                || (params.contains_key("candidateId") && !uuid("candidateId"))
                || (request.method == "edit.request"
                    && !params
                        .get("instruction")
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.trim().is_empty() && v.encode_utf16().count() <= 8000))
            {
                return Err(invalid());
            }
        }
        "preview.open" | "preview.screenshot" => {
            if !uuid("siteId")
                || !uuid("revisionId")
                || (params.contains_key("candidateId") && !uuid("candidateId"))
                || (request.method == "preview.screenshot"
                    && !matches!(
                        params.get("width").and_then(Value::as_u64),
                        Some(375 | 1440)
                    ))
            {
                return Err(invalid());
            }
        }
        "catalog.style.update" => {
            if !text("id", 100) || !params.get("enabled").is_some_and(Value::is_boolean) {
                return Err(invalid());
            }
        }
        "catalog.reference.update" => {
            if !text("id", 100) || !text("description", 16000) {
                return Err(invalid());
            }
        }
        _ => {}
    }
    Ok(())
}
#[tauri::command]
pub async fn dispatch<R: tauri::Runtime>(
    request: DesktopRequest,
    app: tauri::AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<Value, AppError> {
    use tauri::Manager;
    if webview.label() != "main" {
        return Err(AppError {
            code: "FORBIDDEN".into(),
            message: "Only the main webview may dispatch.".into(),
        });
    }
    validate(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<std::sync::Mutex<Worker>>()
            .lock()
            .map_err(|_| AppError::new("Worker lock failed"))?
            .request(request)
    })
    .await
    .map_err(|_| AppError::new("Worker task failed"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn editing_and_publication_schemas_reject_role_and_path_overrides() {
        let site = "11111111-1111-4111-8111-111111111111";
        let candidate = "22222222-2222-4222-8222-222222222222";
        for (method, params) in [
            (
                "edit.request",
                json!({"siteId":site,"instruction":"Updated heading","expectedRevision":1,"candidateId":candidate}),
            ),
            (
                "edit.accept",
                json!({"siteId":site,"candidateId":candidate,"expectedRevision":1}),
            ),
            (
                "edit.reject",
                json!({"siteId":site,"candidateId":candidate}),
            ),
            ("edit.list", json!({"siteId":site})),
            ("chat.list", json!({"siteId":site})),
            ("site.publish", json!({"siteId":site,"expectedRevision":2})),
            (
                "preview.screenshot",
                json!({"siteId":site,"revisionId":candidate,"candidateId":candidate,"width":375}),
            ),
        ] {
            assert!(validate(&DesktopRequest {
                id: "test".into(),
                version: 1,
                method: method.into(),
                params
            })
            .is_ok());
        }
        for (method, params) in [
            (
                "edit.request",
                json!({"siteId":site,"instruction":"","expectedRevision":1}),
            ),
            (
                "edit.request",
                json!({"siteId":site,"instruction":"x","expectedRevision":-1}),
            ),
            (
                "edit.request",
                json!({"siteId":site,"instruction":"x","expectedRevision":1,"role":"admin"}),
            ),
            (
                "edit.accept",
                json!({"siteId":site,"candidateId":candidate,"expectedRevision":1.5}),
            ),
            (
                "edit.reject",
                json!({"siteId":site,"candidateId":"../private"}),
            ),
            ("site.publish", json!({"siteId":site})),
            ("chat.list", json!({"siteId":site,"path":"../private"})),
        ] {
            assert!(validate(&DesktopRequest {
                id: "test".into(),
                version: 1,
                method: method.into(),
                params
            })
            .is_err());
        }
    }
    #[test]
    fn rejects_version_method_and_path_injection() {
        for (version, method, params) in [
            (2, "site.list", json!({})),
            (1, "shell.exec", json!({})),
            (1, "site.list", json!({"path":"C:/secret"})),
            (1, "preview.open", json!({"siteId":"x","revisionId":"../x"})),
        ] {
            assert!(validate(&DesktopRequest {
                id: "test".into(),
                version,
                method: method.into(),
                params
            })
            .is_err());
        }
    }
}

#[cfg(test)]
mod acl_tests {
    use super::*;
    use crate::worker::{LaunchConfig, Worker};
    use serde_json::json;
    use std::path::PathBuf;
    #[test]
    fn acl_grants_only_main_local_webview() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let worker = Worker::new(LaunchConfig {
            node: PathBuf::from(std::env::var_os("SITE_FACTORY_TEST_NODE").unwrap()),
            script: root.join("dist/apps/worker/src/stdio.js"),
            source: root.clone(),
            data: root.join(".local-state/rust-acl-test"),
        })
        .unwrap();
        let app = tauri::test::mock_builder()
            .manage(std::sync::Mutex::new(worker))
            .invoke_handler(tauri::generate_handler![dispatch])
            .build(tauri::generate_context!())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let untrusted = tauri::WebviewWindowBuilder::new(&app, "generated", Default::default())
            .build()
            .unwrap();
        let invoke = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>, url: &str| {
            tauri::test::get_ipc_response(
                window,
                tauri::webview::InvokeRequest {
                    cmd: "dispatch".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: url.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        json!({"request":{"id":"acl","version":1,"method":"device.status","params":{}}}),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        let local = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        assert_eq!(
            invoke(&main, local)
                .unwrap()
                .deserialize::<Value>()
                .unwrap()["mode"],
            "demo"
        );
        let denied = invoke(&untrusted, local).unwrap_err();
        assert!(
            denied
                .as_str()
                .is_some_and(|message| message.contains("not allowed")),
            "ACL must deny before command label guard: {denied}"
        );
        assert!(invoke(&main, "https://example.test").is_err());
    }
}
