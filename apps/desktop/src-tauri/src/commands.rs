use crate::worker::Worker;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[path = "visual.rs"]
mod visual;
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
    if request.method.starts_with("visual.") {
        return visual::validate(&request.method, &request.params);
    }
    let allowed: &[&str] = match request.method.as_str() {
        "usage.summary" | "device.status" | "catalog.list" | "recovery.status"
        | "recovery.release" => &[],
        "site.history" => &["siteId", "offset"],
        "site.rollback" => &["siteId", "revisionId", "expectedRevision", "requestKey"],
        "source.list" => &["siteId", "revisionId"],
        "source.read" => &["siteId", "revisionId", "path", "offset"],
        "site.list" => &["cursor", "limit", "domain", "status", "batchId"],
        "resource.begin" => &["name", "size", "sha256", "draftId", "rowNumber", "revision"],
        "resource.chunk" => &["id", "index", "base64"],
        "import.prepare" | "logo.complete" | "batch.get" | "batch.pause" | "batch.resume"
        | "batch.cancel" => &["id"],
        "import.update" => &[
            "id",
            "revision",
            "rowNumber",
            "domain",
            "about",
            "referenceId",
        ],
        "import.commit" => &["id", "revision", "requestKey"],
        "batch.list" => &["cursor"],
        "batch.rows" => &["id", "cursor", "status"],
        "batch.retry" => &["id", "rowNumber", "modelIdentity"],
        "batch.assign" => &["id", "userIds"],
        "site.create" => &["domain", "about", "referenceId"],
        "site.health" | "site.usage" | "job.status" | "job.retry" | "job.cancel" | "edit.list"
        | "chat.list" => &["siteId"],
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
        "site.history" | "site.rollback" | "source.list" | "source.read" => {
            if !uuid("siteId")
                || (request.method != "site.history" && !uuid("revisionId"))
                || params
                    .get("offset")
                    .is_some_and(|v| v.as_u64().is_none_or(|n| n > 2_000_000))
            {
                return Err(invalid());
            }
            if request.method == "site.rollback"
                && (!uuid("requestKey")
                    || params
                        .get("expectedRevision")
                        .and_then(Value::as_u64)
                        .is_none())
            {
                return Err(invalid());
            }
            if request.method == "source.read"
                && (!text("path", 240)
                    || params["path"].as_str().unwrap().split('/').any(|p| {
                        p.is_empty()
                            || p == "."
                            || p == ".."
                            || !p
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    }))
            {
                return Err(invalid());
            }
        }
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
        "site.health" | "site.usage" | "job.status" | "job.retry" | "job.cancel" | "edit.list"
        | "chat.list" => {
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
        "resource.begin" => {
            let logo = params.contains_key("draftId");
            if !text("name", 800)
                || !params
                    .get("size")
                    .and_then(Value::as_u64)
                    .is_some_and(|v| v > 0 && v <= if logo { 2_000_000 } else { 16 * 1024 * 1024 })
                || !params
                    .get("sha256")
                    .and_then(Value::as_str)
                    .is_some_and(|v| {
                        v.len() == 64
                            && v.bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    })
                || (logo
                    && (!uuid("draftId")
                        || !params
                            .get("rowNumber")
                            .and_then(Value::as_u64)
                            .is_some_and(|v| (2..=5001).contains(&v))
                        || !params
                            .get("revision")
                            .and_then(Value::as_u64)
                            .is_some_and(|v| v <= 9_007_199_254_740_991)))
            {
                return Err(invalid());
            }
        }
        "resource.chunk" => {
            if !uuid("id")
                || !params
                    .get("index")
                    .and_then(Value::as_u64)
                    .is_some_and(|v| v <= 699)
                || !params
                    .get("base64")
                    .and_then(Value::as_str)
                    .is_some_and(|v| {
                        !v.is_empty()
                            && v.len() <= 32000
                            && v.len() % 4 == 0
                            && v.bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
                    })
            {
                return Err(invalid());
            }
        }
        "import.prepare" | "logo.complete" | "batch.get" | "batch.pause" | "batch.resume"
        | "batch.cancel" => {
            if !uuid("id") {
                return Err(invalid());
            }
        }
        "import.update" | "import.commit" | "batch.retry" => {
            if !uuid("id")
                || (request.method != "batch.retry"
                    && !params
                        .get("revision")
                        .and_then(Value::as_u64)
                        .is_some_and(|v| v <= 9_007_199_254_740_991))
                || (request.method != "import.commit"
                    && !params
                        .get("rowNumber")
                        .and_then(Value::as_u64)
                        .is_some_and(|v| (2..=5001).contains(&v)))
                || (request.method == "import.commit" && !text("requestKey", 100))
            {
                return Err(invalid());
            }
            for (field, max) in [("domain", 253), ("about", 8000), ("referenceId", 100)] {
                if params.contains_key(field)
                    && !params
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.encode_utf16().count() <= max)
                {
                    return Err(invalid());
                }
            }
        }
        "batch.rows" => {
            if !uuid("id")
                || params
                    .get("status")
                    .is_some_and(|v| !matches!(v.as_str(), Some("all" | "valid" | "invalid")))
            {
                return Err(invalid());
            }
        }
        "batch.assign" => {
            if !uuid("id")
                || !params
                    .get("userIds")
                    .and_then(Value::as_array)
                    .is_some_and(|v| {
                        v.len() <= 100
                            && v.iter().all(|x| {
                                x.as_str().is_some_and(|s| {
                                    s.len() == 36
                                        && s.bytes().enumerate().all(|(i, c)| {
                                            if [8, 13, 18, 23].contains(&i) {
                                                c == b'-'
                                            } else {
                                                c.is_ascii_hexdigit()
                                            }
                                        })
                                })
                            })
                    })
            {
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
#[tauri::command]
pub async fn model_settings<R: tauri::Runtime>(
    request: crate::secrets::SettingsRequest,
    app: tauri::AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<Value, AppError> {
    use tauri::Manager;
    if webview.label() != "main" {
        return Err(AppError {
            code: "FORBIDDEN".into(),
            message: "Only the main webview may configure models.".into(),
        });
    }
    request.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<std::sync::Mutex<Worker>>()
            .lock()
            .map_err(|_| AppError::new("Worker lock failed"))?
            .settings(request)
    })
    .await
    .map_err(|_| AppError::new("Settings task failed"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn monitoring_is_scoped_read_only_and_never_accepts_probe_authority() {
        let id = "11111111-1111-4111-8111-111111111111";
        for (method, params) in [
            ("site.health", json!({"siteId":id})),
            ("site.usage", json!({"siteId":id})),
            ("usage.summary", json!({})),
        ] {
            assert!(validate(&DesktopRequest {
                id: "monitor".into(),
                version: 1,
                method: method.into(),
                params
            })
            .is_ok());
        }
        for (method, params) in [
            ("health.probe", json!({"siteId":id})),
            (
                "site.health",
                json!({"siteId":id,"url":"https://private.test"}),
            ),
            ("site.usage", json!({"siteId":"invalid"})),
            ("usage.summary", json!({"role":"admin"})),
        ] {
            assert!(validate(&DesktopRequest {
                id: "monitor".into(),
                version: 1,
                method: method.into(),
                params
            })
            .is_err());
        }
    }
    #[test]
    fn staged_import_schemas_reject_paths_roles_and_unbounded_fields() {
        let id = "11111111-1111-4111-8111-111111111111";
        for (method, params) in [
            (
                "resource.begin",
                json!({"name":"sites.csv","size":1,"sha256":"a".repeat(64)}),
            ),
            ("resource.chunk", json!({"id":id,"index":0,"base64":"YQ=="})),
            (
                "import.update",
                json!({"id":id,"revision":1,"rowNumber":2,"about":"Exact row"}),
            ),
            (
                "import.commit",
                json!({"id":id,"revision":1,"requestKey":"request"}),
            ),
            ("batch.rows", json!({"id":id,"status":"invalid"})),
        ] {
            assert!(validate(&DesktopRequest {
                id: "fixture".into(),
                version: 1,
                method: method.into(),
                params
            })
            .is_ok());
        }
        for (method, params) in [
            (
                "resource.begin",
                json!({"name":"sites.csv","size":17000000,"sha256":"a".repeat(64)}),
            ),
            (
                "resource.chunk",
                json!({"id":"../secret","index":0,"base64":"YQ=="}),
            ),
            (
                "resource.chunk",
                json!({"id":id,"index":0,"base64":"A".repeat(33000)}),
            ),
            (
                "import.update",
                json!({"id":id,"revision":1,"rowNumber":2,"role":"admin"}),
            ),
            (
                "import.commit",
                json!({"id":id,"revision":-1,"requestKey":"request"}),
            ),
        ] {
            assert!(validate(&DesktopRequest {
                id: "fixture".into(),
                version: 1,
                method: method.into(),
                params
            })
            .is_err());
        }
    }
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
    fn individual_cancel_accepts_only_a_site_identity() {
        let good = DesktopRequest {
            id: "cancel".into(),
            version: 1,
            method: "job.cancel".into(),
            params: json!({"siteId":"11111111-1111-4111-8111-111111111111"}),
        };
        assert!(validate(&good).is_ok());
        for params in [
            json!({"siteId":"../other"}),
            json!({"siteId":"11111111-1111-4111-8111-111111111111","workerId":"foreign"}),
        ] {
            assert!(validate(&DesktopRequest {
                id: "cancel".into(),
                version: 1,
                method: "job.cancel".into(),
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
            (
                1,
                "model.configure",
                json!({"mode":"live","apiKey":"synthetic","model":"explicit"}),
            ),
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
            .invoke_handler(tauri::generate_handler![dispatch, model_settings])
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
        let invoke_settings = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
                               url: &str| {
            tauri::test::get_ipc_response(
                window,
                tauri::webview::InvokeRequest {
                    cmd: "model_settings".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: url.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(json!({"request":{"action":"status"}})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        assert_eq!(
            invoke_settings(&main, local)
                .unwrap()
                .deserialize::<Value>()
                .unwrap()["mode"],
            "demo"
        );
        assert!(invoke_settings(&untrusted, local)
            .unwrap_err()
            .as_str()
            .is_some_and(|message| message.contains("not allowed")));
        assert!(invoke_settings(&main, "https://example.test").is_err());
    }
}

#[tauri::command]
pub async fn managed_worker<R: tauri::Runtime>(
    request: crate::managed::ManagedRequest,
    app: tauri::AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<Value, AppError> {
    use tauri::Manager;
    if webview.label() != "main" {
        return Err(AppError {
            code: "FORBIDDEN".into(),
            message: "Only the main local window may enroll a device".into(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<std::sync::Mutex<Worker>>()
            .lock()
            .map_err(|_| AppError::new("Worker lock failed"))?
            .managed(request)
    })
    .await
    .map_err(|_| AppError::new("Managed worker task failed"))?
}
