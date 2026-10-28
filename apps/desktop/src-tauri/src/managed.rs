use crate::commands::AppError;
use crate::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ManagedRequest {
    Status {},
    Enroll {
        origin: String,
        name: String,
        #[serde(rename = "accessToken")]
        access_token: String,
    },
    Start {
        #[serde(rename = "expectedOrigin")]
        expected_origin: String,
        mode: Option<String>,
    },
    Stop {
        #[serde(rename = "expectedOrigin")]
        expected_origin: String,
    },
    Revoke {
        #[serde(rename = "expectedOrigin")]
        expected_origin: String,
        #[serde(rename = "accessToken")]
        access_token: String,
    },
}
const KEY: &str = "site-factory.worker";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Enrollment {
    worker_id: String,
    token: String,
    origin: String,
    name: String,
    acknowledged: bool,
}
fn read(secrets: &dyn SecretStore) -> Result<Option<Enrollment>, AppError> {
    let Some(encoded) = secrets.get(KEY)? else {
        return Ok(None);
    };
    if encoded.len() > 4096 || encoded.len() % 2 != 0 || !encoded.is_ascii() {
        return Err(AppError::new("Invalid saved enrollment"));
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&encoded[i..i + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AppError::new("Invalid saved enrollment"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| AppError::new("Invalid saved enrollment"))
}
fn save(secrets: &dyn SecretStore, enrollment: &Enrollment) -> Result<(), AppError> {
    // The whole pending descriptor and credential are one OS-store value. Hex is
    // transport encoding only; protection is provided by the OS secret store.
    let bytes = serde_json::to_vec(enrollment).map_err(|_| AppError::new("Invalid enrollment"))?;
    secrets.put(
        KEY,
        &bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
    )
}
fn valid_origin(value: &str) -> Result<(), AppError> {
    let url = tauri::Url::parse(value).map_err(|_| AppError::new("Invalid control origin"))?;
    if value.len() > 500
        || url.scheme() != "https"
        || url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::new("Invalid control origin"));
    }
    Ok(())
}
fn bound_enrollment<'a>(
    saved: &'a Option<Enrollment>,
    expected_origin: &str,
) -> Result<&'a Enrollment, AppError> {
    valid_origin(expected_origin)?;
    let current = saved
        .as_ref()
        .ok_or_else(|| AppError::new("No enrollment"))?;
    if current.origin != expected_origin {
        return Err(AppError {
            code: "CONFLICT".into(),
            message: "Device belongs to a different control origin".into(),
        });
    }
    Ok(current)
}
pub fn handle(
    secrets: &dyn SecretStore,
    mut call: impl FnMut(&str, Value) -> Result<Value, AppError>,
    request: ManagedRequest,
) -> Result<Value, AppError> {
    let mut saved = read(secrets)?;
    match request {
        ManagedRequest::Enroll {
            origin,
            name,
            access_token,
        } => {
            valid_origin(&origin)?;
            if name.trim().is_empty()
                || name.chars().count() > 100
                || access_token.is_empty()
                || access_token.len() > 16000
            {
                return Err(AppError::new("Invalid enrollment request"));
            }
            if let Some(existing) = &saved {
                if existing.origin != origin || existing.name != name {
                    return Err(AppError::new(
                        "Revoke the existing enrollment before changing its binding",
                    ));
                }
            } else {
                let prepared = call("managed.prepare", json!({}))?;
                let id = prepared["workerId"]
                    .as_str()
                    .ok_or_else(|| AppError::new("Invalid private identity"))?;
                let token = prepared["token"]
                    .as_str()
                    .ok_or_else(|| AppError::new("Invalid private credential"))?;
                if id.len() != 36
                    || token.len() != 43
                    || !token
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err(AppError::new("Invalid private enrollment"));
                }
                let pending = Enrollment {
                    worker_id: id.into(),
                    token: token.into(),
                    origin,
                    name,
                    acknowledged: false,
                };
                save(secrets, &pending)?;
                saved = Some(pending);
            }
            let current = saved.as_mut().unwrap();
            let response = call(
                "managed.enroll",
                json!({"workerId":current.worker_id,"token":current.token,"name":current.name,"controlOrigin":current.origin,"accessToken":access_token}),
            )?;
            if response["workerId"] != current.worker_id || response["name"] != current.name {
                return Err(AppError::new("Enrollment response mismatch"));
            }
            current.acknowledged = true;
            save(secrets, current)?;
        }
        ManagedRequest::Start { expected_origin,mode } => {
            if mode.as_deref().is_some_and(|v|v!="all"&&v!="visual"){return Err(AppError::new("Invalid worker mode"));}
            let current = bound_enrollment(&saved, &expected_origin)?;
            if !current.acknowledged {
                return Err(AppError::new("Complete enrollment first"));
            }
            call(
                "managed.start",
                json!({"workerId":current.worker_id,"token":current.token,"controlOrigin":current.origin,"mode":mode.unwrap_or_else(||"all".into())}),
            )?;
        }
        ManagedRequest::Stop { expected_origin } => {
            bound_enrollment(&saved, &expected_origin)?;
            call("managed.stop", json!({}))?;
        }
        ManagedRequest::Revoke {
            access_token,
            expected_origin,
        } => {
            let current = bound_enrollment(&saved, &expected_origin)?;
            if access_token.is_empty() || access_token.len() > 16000 {
                return Err(AppError::new("Invalid session"));
            }
            call(
                "managed.revoke",
                json!({"workerId":current.worker_id,"controlOrigin":current.origin,"accessToken":access_token}),
            )?;
            secrets.delete(KEY)?;
            saved = None;
        }
        ManagedRequest::Status {} => {}
    }
    let status = call("managed.status", json!({}))?;
    // Never forward a private sidecar envelope to the renderer.
    Ok(
        json!({"workerId":saved.as_ref().map(|s|&s.worker_id),"name":saved.as_ref().map(|s|&s.name),"origin":saved.as_ref().map(|s|&s.origin),"enrolled":saved.as_ref().is_some_and(|s|s.acknowledged),"running":status["running"].as_bool().unwrap_or(false),"error":status["error"].as_str().map(|_|"Исполнитель остановлен; проверьте доступ и подключение.")}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[test]
    fn native_enrollment_acl_rejects_generated_and_remote_views_without_os_access() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![crate::commands::managed_worker])
            .build(tauri::generate_context!())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let generated = tauri::WebviewWindowBuilder::new(&app, "generated", Default::default())
            .build()
            .unwrap();
        let invoke = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>, origin: &str| {
            tauri::test::get_ipc_response(
                window,
                tauri::webview::InvokeRequest {
                    cmd: "managed_worker".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: origin.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(json!({"request":{"action":"invalid"}})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .unwrap_err()
        };
        let local = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        assert!(invoke(&generated, local)
            .as_str()
            .is_some_and(|s| s.contains("not allowed")));
        assert!(invoke(&main, "https://control.test")
            .as_str()
            .is_some_and(|s| s.contains("not allowed")));
        // A local main view reaches DTO validation, without invoking any OS secret
        // operation or worker state. This uses Tauri's mock runtime, never a GUI.
        assert!(invoke(&main, local)
            .as_str()
            .is_some_and(|s| s.contains("unknown variant")));
    }
    struct Memory(Mutex<Option<String>>);
    impl SecretStore for Memory {
        fn put(&self, _: &str, v: &str) -> Result<(), AppError> {
            *self.0.lock().unwrap() = Some(v.into());
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Option<String>, AppError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn delete(&self, _: &str) -> Result<(), AppError> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }
    #[test]
    fn enrollment_response_loss_reuses_persisted_secret_and_never_returns_it() {
        let store = Memory(Mutex::new(None));
        let token = "x".repeat(43);
        let mut attempts = 0;
        let mut prepared = 0;
        let mut call = |method: &str, params: Value| -> Result<Value, AppError> {
            match method {
                "managed.prepare" => {
                    prepared += 1;
                    Ok(json!({"workerId":"11111111-1111-4111-8111-111111111111","token":token}))
                }
                "managed.enroll" => {
                    assert!(store.0.lock().unwrap().is_some());
                    assert_eq!(params["token"], token);
                    attempts += 1;
                    if attempts == 1 {
                        Err(AppError::new("lost response"))
                    } else {
                        Ok(json!({"workerId":params["workerId"],"name":params["name"]}))
                    }
                }
                "managed.status" => Ok(json!({"running":false,"error":null})),
                _ => Ok(json!({"running":true,"error":null})),
            }
        };
        let enroll = || ManagedRequest::Enroll {
            origin: "https://control.test".into(),
            name: "Рабочая машина".into(),
            access_token: "transient-admin".into(),
        };
        assert!(handle(&store, &mut call, enroll()).is_err());
        let result = handle(&store, &mut call, enroll()).unwrap();
        assert!(!result.to_string().contains(&token));
        assert!(!result.to_string().contains("transient-admin"));
        handle(
            &store,
            &mut call,
            ManagedRequest::Start {
                expected_origin: "https://control.test".into(),
                mode:None,
            },
        )
        .unwrap();
        drop(call);
        assert_eq!(prepared, 1);
        assert_eq!(attempts, 2);
        assert!(!store
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains("transient-admin"));
    }
    #[test]
    fn lifecycle_origin_mismatch_never_reaches_private_pipe_or_erases_saved_identity() {
        for acknowledged in [false, true] {
            let store = Memory(Mutex::new(None));
            save(
                &store,
                &Enrollment {
                    worker_id: "11111111-1111-4111-8111-111111111111".into(),
                    token: "x".repeat(43),
                    origin: "https://installation-a.test".into(),
                    name: "Saved A".into(),
                    acknowledged,
                },
            )
            .unwrap();
            let before = store.0.lock().unwrap().clone();
            let mut calls = Vec::new();
            for action in ["start", "stop", "revoke"] {
                let mut payload =
                    json!({"action":action,"expectedOrigin":"https://installation-b.test"});
                if action == "revoke" {
                    payload["accessToken"] = json!("installation-b-admin");
                }
                let request = serde_json::from_value::<ManagedRequest>(payload).unwrap();
                let result = handle(
                    &store,
                    |method, params| {
                        calls.push((method.to_string(), params));
                        Ok(json!({"running":false,"error":null}))
                    },
                    request,
                );
                assert!(
                    result.is_err(),
                    "Saved A must reject current B before {action}"
                );
                assert!(
                    calls.is_empty(),
                    "No HTTP or private sidecar command may receive a mismatched action"
                );
                assert_eq!(*store.0.lock().unwrap(), before);
            }
            if acknowledged {
                for action in ["start", "stop", "revoke"] {
                    let mut payload =
                        json!({"action":action,"expectedOrigin":"https://installation-a.test"});
                    if action == "revoke" {
                        payload["accessToken"] = json!("installation-a-admin");
                    }
                    let request = serde_json::from_value::<ManagedRequest>(payload).unwrap();
                    handle(
                        &store,
                        |method, params| {
                            if method == "managed.start" || method == "managed.revoke" {
                                assert_eq!(params["controlOrigin"], "https://installation-a.test");
                            }
                            if method == "managed.revoke" {
                                assert_eq!(params["accessToken"], "installation-a-admin");
                            }
                            calls.push((method.to_string(), params));
                            Ok(json!({"running":false,"error":null}))
                        },
                        request,
                    )
                    .unwrap();
                }
                assert_eq!(
                    calls
                        .iter()
                        .map(|(method, _)| method.as_str())
                        .collect::<Vec<_>>(),
                    vec![
                        "managed.start",
                        "managed.status",
                        "managed.stop",
                        "managed.status",
                        "managed.revoke",
                        "managed.status"
                    ]
                );
                assert!(store.0.lock().unwrap().is_none());
            }
        }
    }
    #[test]
    fn ambiguous_os_write_is_recovered_before_any_network_request() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Ambiguous {
            value: Mutex<Option<String>>,
            fail: AtomicBool,
        }
        impl SecretStore for Ambiguous {
            fn put(&self, _: &str, v: &str) -> Result<(), AppError> {
                *self.value.lock().unwrap() = Some(v.into());
                if self.fail.swap(false, Ordering::SeqCst) {
                    Err(AppError::new("OS write response lost"))
                } else {
                    Ok(())
                }
            }
            fn get(&self, _: &str) -> Result<Option<String>, AppError> {
                Ok(self.value.lock().unwrap().clone())
            }
            fn delete(&self, _: &str) -> Result<(), AppError> {
                Ok(())
            }
        }
        let store = Ambiguous {
            value: Mutex::new(None),
            fail: AtomicBool::new(true),
        };
        let mut prepared = 0;
        let mut enrolled = 0;
        let mut call = |method: &str, params: Value| -> Result<Value, AppError> {
            match method {
                "managed.prepare" => {
                    prepared += 1;
                    Ok(
                        json!({"workerId":"11111111-1111-4111-8111-111111111111","token":"x".repeat(43)}),
                    )
                }
                "managed.enroll" => {
                    enrolled += 1;
                    Ok(json!({"workerId":params["workerId"],"name":params["name"]}))
                }
                _ => Ok(json!({"running":false,"error":null})),
            }
        };
        let request = || ManagedRequest::Enroll {
            origin: "https://control.test".into(),
            name: "Saved machine".into(),
            access_token: "admin".into(),
        };
        assert!(handle(&store, &mut call, request()).is_err());
        handle(&store, &mut call, request()).unwrap();
        let saved = store.value.lock().unwrap().clone();
        assert!(handle(
            &store,
            &mut call,
            ManagedRequest::Enroll {
                origin: "https://foreign.test".into(),
                name: "Saved machine".into(),
                access_token: "admin".into()
            }
        )
        .is_err());
        assert_eq!(*store.value.lock().unwrap(), saved);
        drop(call);
        assert_eq!(prepared, 1);
        assert_eq!(enrolled, 1);
    }
    #[test]
    fn renderer_cannot_supply_worker_credentials_or_private_commands() {
        for action in ["start", "stop", "revoke"] {
            let payload = if action == "revoke" {
                json!({"action":action,"accessToken":"admin"})
            } else {
                json!({"action":action})
            };
            assert!(
                serde_json::from_value::<ManagedRequest>(payload).is_err(),
                "Lifecycle actions require the current configured origin"
            );
        }
        assert!(serde_json::from_value::<ManagedRequest>(json!({"action":"enroll","origin":"https://control.test","name":"Machine","accessToken":"admin","token":"injected"})).is_err());
        assert!(valid_origin("https://control.test/foreign").is_err());
        assert!(valid_origin("https://user:password@control.test").is_err());
    }
}
