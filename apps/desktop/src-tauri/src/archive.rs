use crate::{commands::AppError, worker::Worker};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Remote {
    origin: String,
    #[serde(rename = "accessToken")]
    access_token: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    #[serde(rename = "sourceId")]
    source_id: String,
    #[serde(rename = "destinationId")]
    destination_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Backup {
        passphrase: String,
        remote: Option<Remote>,
    },
    Source {
        #[serde(rename = "siteId")]
        site_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
        remote: Option<Remote>,
    },
    File {
        #[serde(rename = "siteId")]
        site_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
        path: String,
        remote: Option<Remote>,
    },
    Inspect {
        passphrase: String,
        remote: Option<Remote>,
    },
    Restore {
        id: String,
        mappings: Vec<Mapping>,
        remote: Option<Remote>,
    },
    Map {
        id: String,
        mappings: Vec<Mapping>,
        remote: Option<Remote>,
    },
    Status {
        id: String,
        remote: Option<Remote>,
    },
    Save {
        id: String,
        remote: Option<Remote>,
    },
    Close {
        id: String,
        remote: Option<Remote>,
    },
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl Request {
    pub fn validate(&self) -> Result<(), AppError> {
        let remote = match self {
            Self::Backup { passphrase, remote } | Self::Inspect { passphrase, remote } => {
                if !(8..=1024).contains(&passphrase.len()) {
                    return Err(AppError::new("Invalid archive passphrase length"));
                }
                remote
            }
            Self::Source {
                site_id,
                revision_id,
                remote,
            }
            | Self::File {
                site_id,
                revision_id,
                remote,
                ..
            } => {
                if !uuid(site_id) || !uuid(revision_id) {
                    return Err(AppError::new("Invalid source identity"));
                }
                remote
            }
            Self::Restore {
                id,
                mappings,
                remote,
            }
            | Self::Map {
                id,
                mappings,
                remote,
            } => {
                if !uuid(id)
                    || mappings.len() > 50
                    || mappings
                        .iter()
                        .any(|m| !uuid(&m.source_id) || !uuid(&m.destination_id))
                {
                    return Err(AppError::new("Invalid restore mapping batch"));
                }
                remote
            }
            Self::Status { id, remote }
            | Self::Save { id, remote }
            | Self::Close { id, remote } => {
                if !uuid(id) {
                    return Err(AppError::new("Invalid archive handle"));
                }
                remote
            }
        };
        if let Self::File { path, .. } = self {
            if path.is_empty()
                || path.len() > 240
                || path.split('/').any(|p| {
                    p.is_empty()
                        || p == "."
                        || p == ".."
                        || !p
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                })
            {
                return Err(AppError::new("Invalid source path"));
            }
        }
        if let Some(r) = remote {
            let u = tauri::Url::parse(&r.origin)
                .map_err(|_| AppError::new("Invalid configured control origin"))?;
            if r.origin.len() > 2048
                || u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.path() != "/"
                || u.query().is_some()
                || u.fragment().is_some()
                || r.access_token.len() > 8192
                || r.access_token.is_empty()
                || r.access_token.chars().any(char::is_control)
            {
                return Err(AppError::new("Invalid configured archive transport"));
            }
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn archive_operation<R: tauri::Runtime>(
    request: Request,
    app: tauri::AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<Value, AppError> {
    if webview.label() != "main" {
        return Err(AppError {
            code: "FORBIDDEN".into(),
            message: "Only the main local webview may use archives.".into(),
        });
    }
    request.validate()?;
    let mut params =
        serde_json::to_value(&request).map_err(|_| AppError::new("Invalid archive request"))?;
    if matches!(request, Request::Inspect { .. }) {
        let file = rfd::AsyncFileDialog::new()
            .set_title("Выберите зашифрованную копию")
            .add_filter("Site Factory backup", &["sfbak"])
            .pick_file()
            .await
            .ok_or_else(|| AppError::new("Выбор файла отменён."))?;
        params["archivePath"] = Value::String(
            file.path()
                .to_str()
                .ok_or_else(|| AppError::new("Invalid selected file"))?
                .into(),
        );
    }
    if matches!(request, Request::Save { .. }) {
        let mut status = params.clone();
        status["action"] = Value::String("status".into());
        let target = app.clone();
        let metadata = tauri::async_runtime::spawn_blocking(move || {
            target
                .state::<std::sync::Mutex<Worker>>()
                .lock()
                .map_err(|_| AppError::new("Worker lock failed"))?
                .archive(status)
        })
        .await
        .map_err(|_| AppError::new("Archive metadata unavailable"))??;
        let name = metadata
            .pointer("/result/handle/name")
            .and_then(Value::as_str)
            .unwrap_or("site-factory-export");
        if name.len() > 240
            || name
                .chars()
                .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        {
            return Err(AppError::new("Invalid export name"));
        }
        let file = rfd::AsyncFileDialog::new()
            .set_title("Сохранить независимую копию")
            .set_file_name(name)
            .save_file()
            .await
            .ok_or_else(|| AppError::new("Сохранение отменено."))?;
        params["destination"] = Value::String(
            file.path()
                .to_str()
                .ok_or_else(|| AppError::new("Invalid selected destination"))?
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<std::sync::Mutex<Worker>>()
            .lock()
            .map_err(|_| AppError::new("Worker lock failed"))?
            .archive(params)
    })
    .await
    .map_err(|_| AppError::new("Archive transport failed"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_generic_paths_secrets_and_unbounded_parameters() {
        let id = "11111111-1111-4111-8111-111111111111";
        for value in [
            json!({"action":"status","id":id,"passphrase":"secret secret"}),
            json!({"action":"inspect","passphrase":"secret secret","archivePath":"C:/secret"}),
            json!({"action":"save","id":id,"destination":"C:/secret"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        for value in [
            json!({"action":"backup","passphrase":"x"}),
            json!({"action":"file","siteId":id,"revisionId":id,"path":"../secret"}),
            json!({"action":"status","id":id,"remote":{"origin":"https://example.test/preview","accessToken":"token"}}),
        ] {
            assert!(serde_json::from_value::<Request>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<Request>(
            json!({"action":"backup","passphrase":"secret secret"})
        )
        .unwrap()
        .validate()
        .is_ok());
    }
}
