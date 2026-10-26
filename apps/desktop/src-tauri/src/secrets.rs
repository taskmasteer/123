use crate::commands::AppError;
use serde::{Deserialize, Serialize};
pub const CREDENTIAL_NAME: &str = "site-factory.openai";
pub trait SecretStore: Send {
    fn put(&self, name: &str, secret: &str) -> Result<(), AppError>;
    fn get(&self, name: &str) -> Result<Option<String>, AppError>;
    fn delete(&self, name: &str) -> Result<(), AppError>;
}
pub struct OsSecretStore;
impl SecretStore for OsSecretStore {
    fn put(&self, name: &str, secret: &str) -> Result<(), AppError> {
        valid_name(name)?;
        valid_secret(secret)?;
        platform::put(name, secret)
    }
    fn get(&self, name: &str) -> Result<Option<String>, AppError> {
        valid_name(name)?;
        platform::get(name)
    }
    fn delete(&self, name: &str) -> Result<(), AppError> {
        valid_name(name)?;
        platform::delete(name)
    }
}
fn unavailable() -> AppError {
    AppError {
        code: "NEEDS_ATTENTION".into(),
        message: "Хранилище ключей ОС недоступно. Ключ не записан в файл.".into(),
    }
}
fn valid_name(name: &str) -> Result<(), AppError> {
    if name.starts_with("site-factory.")
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    {
        Ok(())
    } else {
        Err(AppError::new("Invalid credential name"))
    }
}
fn valid_secret(secret: &str) -> Result<(), AppError> {
    if !secret.is_empty() && secret.len() <= 4096 && secret.bytes().all(|b| (33..=126).contains(&b))
    {
        Ok(())
    } else {
        Err(AppError::new("Invalid API key"))
    }
}
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && model.as_bytes()[0].is_ascii_alphanumeric()
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Security::Credentials::*;
    fn wide(name: &str) -> Vec<u16> {
        name.encode_utf16().chain(Some(0)).collect()
    }
    pub fn put(name: &str, secret: &str) -> Result<(), AppError> {
        let mut target = wide(name);
        let mut bytes = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        bytes.fill(0);
        if ok == 0 {
            Err(unavailable())
        } else {
            Ok(())
        }
    }
    pub fn get(name: &str) -> Result<Option<String>, AppError> {
        let target = wide(name);
        let mut pointer = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0 {
            return if unsafe { windows_sys::Win32::Foundation::GetLastError() } == 1168 {
                Ok(None)
            } else {
                Err(unavailable())
            };
        }
        let result = unsafe {
            let credential = &*pointer;
            if credential.CredentialBlobSize == 0
                || credential.CredentialBlobSize > 4096
                || credential.CredentialBlob.is_null()
            {
                Err(unavailable())
            } else {
                String::from_utf8(
                    std::slice::from_raw_parts(
                        credential.CredentialBlob,
                        credential.CredentialBlobSize as usize,
                    )
                    .to_vec(),
                )
                .map(Some)
                .map_err(|_| unavailable())
            }
        };
        unsafe { CredFree(pointer.cast()) };
        result
    }
    pub fn delete(name: &str) -> Result<(), AppError> {
        let target = wide(name);
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || unsafe { windows_sys::Win32::Foundation::GetLastError() } == 1168
        {
            Ok(())
        } else {
            Err(unavailable())
        }
    }
}
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use security_framework::passwords::{self, PasswordOptions};
    const SERVICE: &str = "com.sitefactory.desktop";
    pub fn put(name: &str, secret: &str) -> Result<(), AppError> {
        passwords::set_generic_password(SERVICE, name, secret.as_bytes()).map_err(|_| unavailable())
    }
    pub fn get(name: &str) -> Result<Option<String>, AppError> {
        match passwords::generic_password(PasswordOptions::new_generic_password(SERVICE, name)) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| unavailable()),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }
    pub fn delete(name: &str) -> Result<(), AppError> {
        match passwords::delete_generic_password(SERVICE, name) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    pub fn put(_: &str, _: &str) -> Result<(), AppError> {
        Err(unavailable())
    }
    pub fn get(_: &str) -> Result<Option<String>, AppError> {
        Err(unavailable())
    }
    pub fn delete(_: &str) -> Result<(), AppError> {
        Err(unavailable())
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum SettingsRequest {
    Status {},
    Save {
        #[serde(rename = "apiKey")]
        api_key: String,
        model: String,
        #[serde(rename = "imageModel")]
        image_model: Option<String>,
    },
    Delete {},
    Demo {},
}
impl SettingsRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Self::Save {
            api_key,
            model,
            image_model,
        } = self
        {
            valid_secret(api_key)?;
            if !valid_model(model)
                || image_model
                    .as_ref()
                    .is_some_and(|model| !valid_model(model))
            {
                return Err(AppError::new("Invalid explicit model identifier"));
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum SavedModel {
    Demo,
    Blocked,
    Live {
        model: String,
        #[serde(rename = "imageModel", skip_serializing_if = "Option::is_none")]
        image_model: Option<String>,
    },
}
impl SavedModel {
    pub fn read(path: &std::path::Path) -> Result<Self, AppError> {
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() <= 2048 => {
                let saved: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| AppError::new("Invalid saved model configuration"))?;
                if let Self::Live { model, image_model } = &saved {
                    if !valid_model(model)
                        || image_model.as_ref().is_some_and(|id| !valid_model(id))
                    {
                        return Err(AppError::new("Invalid saved model identifier"));
                    }
                }
                Ok(saved)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::Demo),
            _ => Err(AppError::new("Cannot read saved model configuration")),
        }
    }
    pub fn write(&self, path: &std::path::Path) -> Result<(), AppError> {
        use std::io::Write;
        let bytes =
            serde_json::to_vec(self).map_err(|_| AppError::new("Invalid model configuration"))?;
        let mut file = std::fs::File::create(path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_schema_rejects_invalid_models_and_secret_exports() {
        for value in [
            serde_json::json!({"action":"save","apiKey":"synthetic","model":""}),
            serde_json::json!({"action":"save","apiKey":"bad\nheader","model":"configured"}),
        ] {
            let request: SettingsRequest = serde_json::from_value(value).unwrap();
            assert!(request.validate().is_err());
        }
        assert!(serde_json::from_value::<SettingsRequest>(
            serde_json::json!({"action":"status","name":"foreign"})
        )
        .is_err());
        assert!(serde_json::from_value::<SettingsRequest>(
            serde_json::json!({"action":"get","name":CREDENTIAL_NAME})
        )
        .is_err());
    }
    #[test]
    #[ignore = "Explicit synthetic OS credential roundtrip; never reads existing entries"]
    fn synthetic_os_credential_roundtrip() {
        let name = format!(
            "site-factory.synthetic-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = OsSecretStore.delete(&self.0);
            }
        }
        let _cleanup = Cleanup(name.clone());
        let store = OsSecretStore;
        store.put(&name, "synthetic-first").unwrap();
        let outcome = (|| {
            assert_eq!(
                store.get(&name).unwrap().as_deref(),
                Some("synthetic-first")
            );
            store.put(&name, "synthetic-rotated").unwrap();
            assert_eq!(
                store.get(&name).unwrap().as_deref(),
                Some("synthetic-rotated")
            );
        })();
        store.delete(&name).unwrap();
        assert!(store.get(&name).unwrap().is_none());
        outcome
    }
}
