use crate::commands::{validate, AppError, DesktopRequest};
use crate::secrets::{OsSecretStore, SavedModel, SecretStore, SettingsRequest, CREDENTIAL_NAME};
use fs2::FileExt;
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

#[derive(serde::Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LaunchConfig {
    pub node: PathBuf,
    pub script: PathBuf,
    pub source: PathBuf,
    #[serde(skip)]
    pub data: PathBuf,
}
impl LaunchConfig {
    pub fn resolve(resources: &Path, data: PathBuf) -> Result<Self, AppError> {
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("SITE_FACTORY_DEV_CONFIG") {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err(AppError::new("Developer config must be absolute"));
            }
            let bytes = std::fs::read(path)?;
            if bytes.len() > 16000 {
                return Err(AppError::new("Developer config too large"));
            }
            let mut config: Self = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::new("Invalid trusted developer config"))?;
            config.data = data;
            config.check()?;
            return Ok(config);
        }
        let runtime = resources.join("runtime");
        let config = Self {
            node: runtime.join(if cfg!(windows) { "node.exe" } else { "node" }),
            script: runtime.join("apps/worker/src/stdio.js"),
            source: runtime,
            data,
        };
        Ok(config)
    }
    fn check(&self) -> Result<(), AppError> {
        if !self.node.is_absolute()
            || !self.node.is_file()
            || !self.script.is_absolute()
            || !self.script.is_file()
            || !self.source.is_absolute()
            || !self.source.is_dir()
            || !self.data.is_absolute()
        {
            return Err(crate::runtime_package::unavailable());
        }
        if !cfg!(debug_assertions) || self.source.join("manifest.json").is_file() {
            crate::runtime_package::verify_installed(&self.source)?;
        }
        Ok(())
    }
}
struct Process {
    child: Child,
    input: Option<ChildStdin>,
    responses: Receiver<Result<Value, String>>,
    #[cfg(windows)]
    _job: WindowsJob,
}
impl Process {
    fn exited(&mut self) -> bool {
        #[cfg(target_os = "macos")]
        unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            return libc::waitid(
                libc::P_PID,
                self.child.id() as _,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            ) == 0
                && info.si_pid() != 0;
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.child.try_wait().ok().flatten().is_some()
        }
    }
    fn stop(&mut self) {
        self.input.take(); // EOF lets Node checkpoint active jobs and close Chromium.
        let deadline = Instant::now() + Duration::from_secs(15);
        #[cfg(target_os = "macos")]
        {
            while !self.exited() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
            // Retain the direct guard/Node Child until its owned group is killed, preventing PID reuse.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.wait();
            return;
        }
        #[cfg(not(target_os = "macos"))]
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}
pub struct Worker {
    config: LaunchConfig,
    process: Option<Process>,
    _lock: File,
    response_timeout: Duration,
    secrets: Box<dyn SecretStore>,
}
impl Worker {
    pub fn lazy(config: LaunchConfig) -> Result<Self, AppError> {
        Self::create(config, false)
    }
    #[cfg(test)]
    pub fn new(config: LaunchConfig) -> Result<Self, AppError> {
        Self::create(config, true)
    }
    fn create(config: LaunchConfig, start: bool) -> Result<Self, AppError> {
        if start {
            config.check()?;
        }
        std::fs::create_dir_all(&config.data)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(config.data.join("desktop.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| AppError::new("Another local controller is already running."))?;
        let mut worker = Self {
            config,
            process: None,
            _lock: lock,
            response_timeout: Duration::from_secs(30),
            secrets: Box::new(OsSecretStore),
        };
        if start {
            worker.start()?;
        }
        Ok(worker)
    }
    fn start(&mut self) -> Result<(), AppError> {
        self.config.check()?;
        let packaged =
            !cfg!(debug_assertions) || self.config.source.join("manifest.json").is_file();
        #[cfg(target_os = "macos")]
        let mut command = if packaged {
            let mut c = Command::new(
                self.config
                    .source
                    .join("helpers/site-factory-runtime-guard"),
            );
            c.arg("--worker");
            c
        } else {
            let mut c = Command::new(&self.config.node);
            c.arg(&self.config.script);
            c
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = {
            let mut c = Command::new(&self.config.node);
            c.arg(&self.config.script);
            c
        };
        command
            .current_dir(&self.config.data)
            .env_clear()
            .env("SITE_FACTORY_DATA_ROOT", &self.config.data)
            .env("SITE_FACTORY_SOURCE_ROOT", &self.config.source)
            .env("SITE_FACTORY_NATIVE", "1")
            .env(
                "NODE_ENV",
                if cfg!(debug_assertions) {
                    "development"
                } else {
                    "production"
                },
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if packaged {
            let temp = self.config.data.join("runtime-temp");
            std::fs::create_dir_all(&temp)?;
            command
                .env("NODE_ENV", "production")
                .env("SITE_FACTORY_PACKAGED", "1")
                .env("SITE_FACTORY_RUNTIME_ROOT", &self.config.source)
                .env(
                    "PLAYWRIGHT_BROWSERS_PATH",
                    self.config.source.join("browsers"),
                )
                .env("TEMP", &temp)
                .env("TMP", &temp)
                .env("TMPDIR", &temp);
        } else if let Some(path) = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH") {
            command.env("PLAYWRIGHT_BROWSERS_PATH", path);
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let start_gate = self
            .config
            .script
            .ends_with(Path::new("apps/worker/src/stdio.js"));
        if start_gate {
            command.env("SITE_FACTORY_NATIVE_START_GATE", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match WindowsJob::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.into());
            }
        };
        let mut input = child.stdin.take();
        // The fixed bootstrap cannot import worker/runtime or create children before this grant.
        // On Windows this point is strictly after successful kill-on-close Job attachment.
        if start_gate {
            if let Some(pipe) = input.as_mut() {
                pipe.write_all(b"SF_NATIVE_START_V1\n")?;
                pipe.flush()?;
            }
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("Worker stdout missing"))?;
        let (send, responses) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                // Bound a hostile/corrupt response before allocating an unbounded line.
                let parsed = loop {
                    let chunk = match reader.fill_buf() {
                        Ok(chunk) => chunk,
                        Err(e) => break Err(e.to_string()),
                    };
                    if chunk.is_empty() {
                        if line.is_empty() {
                            return;
                        }
                        break Err("Truncated worker response".into());
                    }
                    let count = chunk
                        .iter()
                        .position(|b| *b == b'\n')
                        .map(|n| n + 1)
                        .unwrap_or(chunk.len());
                    if line.len() + count > 9_000_000 {
                        break Err("Worker response too large".into());
                    }
                    let ended = chunk[count - 1] == b'\n';
                    line.extend_from_slice(&chunk[..count]);
                    reader.consume(count);
                    if ended {
                        break serde_json::from_slice(&line).map_err(|e| e.to_string());
                    }
                };
                let failed = parsed.is_err();
                if send.send(parsed).is_err() || failed {
                    return;
                }
            }
        });
        self.process = Some(Process {
            child,
            input,
            responses,
            #[cfg(windows)]
            _job: job,
        });
        self.bootstrap()?;
        Ok(())
    }
    pub fn request(&mut self, request: DesktopRequest) -> Result<Value, AppError> {
        validate(&request)?;
        if self.process.as_mut().map(|p| p.exited()).unwrap_or(true) {
            self.shutdown();
            self.start()?;
        }
        self.exchange(request)
    }
    // This entry point is private Rust-to-worker; renderer dispatch never accepts model.configure.
    fn configure(&mut self, params: Value) -> Result<(), AppError> {
        self.exchange(DesktopRequest {
            id: "native-model-configure".into(),
            version: 1,
            method: "model.configure".into(),
            params,
        })
        .map(|_| ())
    }
    fn bootstrap(&mut self) -> Result<(), AppError> {
        let saved = SavedModel::read(&self.config.data.join("model-settings.json"))
            .unwrap_or(SavedModel::Blocked);
        let mut params = serde_json::to_value(&saved)
            .map_err(|_| AppError::new("Invalid model configuration"))?;
        if matches!(saved, SavedModel::Live { .. }) {
            match self.secrets.get(CREDENTIAL_NAME) {
                Ok(Some(secret)) => params["apiKey"] = Value::String(secret),
                _ => params = serde_json::json!({"mode":"blocked"}),
            }
        }
        self.configure(params)
    }
    pub fn settings(&mut self, request: SettingsRequest) -> Result<Value, AppError> {
        request.validate()?;
        if !matches!(request, SettingsRequest::Status {}) {
            // Stop old calls before rotating/deleting. A failed operation remains blocked on restart.
            let path = self.config.data.join("model-settings.json");
            SavedModel::Blocked.write(&path)?;
            if self.process.is_some() {
                self.configure(serde_json::json!({"mode":"blocked"}))?;
            }
            match request {
                SettingsRequest::Save {
                    api_key,
                    model,
                    image_model,
                } => {
                    self.secrets.put(CREDENTIAL_NAME, &api_key)?;
                    SavedModel::Live { model, image_model }.write(&path)?;
                }
                SettingsRequest::Delete {} => self.secrets.delete(CREDENTIAL_NAME)?,
                SettingsRequest::Demo {} => SavedModel::Demo.write(&path)?,
                SettingsRequest::Status {} => {}
            }
            if self.process.is_some() {
                self.bootstrap()?;
            }
        }
        self.request(DesktopRequest {
            id: "native-model-status".into(),
            version: 1,
            method: "device.status".into(),
            params: serde_json::json!({}),
        })
    }
    pub fn managed(&mut self, request: crate::managed::ManagedRequest) -> Result<Value, AppError> {
        if self.process.as_mut().map(|p| p.exited()).unwrap_or(true) {
            self.shutdown();
            self.start()?;
        }
        crate::managed::handle(
            &OsSecretStore,
            |method, params| {
                self.exchange(DesktopRequest {
                    id: "native-managed".into(),
                    version: 1,
                    method: method.into(),
                    params,
                })
            },
            request,
        )
    }
    pub fn archive(&mut self, params: Value) -> Result<Value, AppError> {
        if self.process.as_mut().map(|p| p.exited()).unwrap_or(true) {
            self.shutdown();
            self.start()?;
        }
        self.exchange(DesktopRequest {
            id: "native-archive".into(),
            version: 1,
            method: "archive.private".into(),
            params,
        })
    }
    fn exchange(&mut self, request: DesktopRequest) -> Result<Value, AppError> {
        let bytes = serde_json::to_vec(&request).map_err(|_| AppError::new("Invalid request"))?;
        if bytes.len() > 64000 {
            return Err(AppError::new("Request too large"));
        }
        let exchange = (|| -> Result<Result<Value, AppError>, AppError> {
            let process = self.process.as_mut().unwrap();
            let input = process
                .input
                .as_mut()
                .ok_or_else(|| AppError::new("Worker is stopping"))?;
            input.write_all(&bytes)?;
            input.write_all(b"\n")?;
            input.flush()?;
            let response = process
                .responses
                .recv_timeout(self.response_timeout)
                .map_err(|_| AppError::new("Worker response unavailable"))?
                .map_err(AppError::new)?;
            let envelope = response
                .as_object()
                .ok_or_else(|| AppError::new("Malformed worker response"))?;
            if envelope.len() != 2
                || response.get("id").and_then(Value::as_str) != Some(request.id.as_str())
            {
                return Err(AppError::new("Mismatched or malformed worker response"));
            }
            if let Some(result) = envelope.get("result") {
                return Ok(Ok(result.clone()));
            }
            let error = envelope
                .get("error")
                .and_then(Value::as_object)
                .ok_or_else(|| AppError::new("Malformed worker error"))?;
            let code = error.get("code").and_then(Value::as_str);
            let message = error.get("message").and_then(Value::as_str);
            match (code, message) {
                (Some(code), Some(message))
                    if error.len() == 2 && !code.is_empty() && !message.is_empty() =>
                {
                    Ok(Err(AppError {
                        code: code.into(),
                        message: message.into(),
                    }))
                }
                _ => Err(AppError::new("Malformed worker error")),
            }
        })();
        match exchange {
            Ok(response) => response,
            Err(_) => {
                // Never send another request on an ambiguous stream, and never replay
                // the failed request: its mutation may already have been committed.
                self.shutdown();
                Err(AppError {
                    code: "NEEDS_ATTENTION".into(),
                    message: "Связь с исполнителем прервана. Операция могла сохраниться; проверьте состояние перед повтором. Следующий запрос запустит исполнитель заново.".into(),
                })
            }
        }
    }
    pub fn shutdown(&mut self) {
        self.process.take();
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.shutdown();
    }
}
pub fn package_smoke(resources: &Path) -> Result<Value, AppError> {
    struct FixtureSecrets;
    impl SecretStore for FixtureSecrets {
        fn get(&self, _: &str) -> Result<Option<String>, AppError> {
            Ok(None)
        }
        fn put(&self, _: &str, _: &str) -> Result<(), AppError> {
            Err(AppError::new("Fixture cannot store credentials"))
        }
        fn delete(&self, _: &str) -> Result<(), AppError> {
            Err(AppError::new("Fixture cannot delete credentials"))
        }
    }
    let parent = std::env::temp_dir().canonicalize()?;
    let data = parent.join(format!(
        "site-factory-package-smoke-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let result = (|| {
        let config = LaunchConfig::resolve(resources, data.clone())?;
        let mut worker = Worker::lazy(config)?;
        worker.secrets = Box::new(FixtureSecrets);
        worker.settings(SettingsRequest::Demo {})?;
        let request = |method: &str, params: Value| DesktopRequest {
            id: "package-smoke".into(),
            version: 1,
            method: method.into(),
            params,
        };
        let created=worker.request(request("site.create",serde_json::json!({"domain":"package-fixture.example","about":"A personal noncommercial fixture about careful garden tools.","referenceId":"editorial"})))?;
        let id = created["site"]["id"]
            .as_str()
            .ok_or_else(|| AppError::new("Fixture did not create a site"))?
            .to_owned();
        let deadline = Instant::now() + Duration::from_secs(60);
        let published;
        loop {
            let list = worker.request(request("site.list", serde_json::json!({})))?;
            let site = list["items"]
                .as_array()
                .and_then(|sites| sites.iter().find(|s| s["id"] == id))
                .ok_or_else(|| AppError::new("Fixture site missing"))?;
            if site["generationStatus"] == "completed" {
                published = site["publishedId"].clone();
                break;
            }
            if Instant::now() > deadline || site["generationStatus"] == "needs_attention" {
                return Err(AppError::new(format!(
                    "Fixture generation did not finish: {}",
                    site["generationStatus"]
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        worker.shutdown();
        let restored = worker.request(request("site.list", serde_json::json!({})))?;
        let restart = restored["items"].as_array().is_some_and(|sites| {
            sites
                .iter()
                .any(|site| site["id"] == id && site["publishedId"] == published)
        });
        let mut forwarded = false;
        let denied = crate::managed::handle(
            &FixtureSecrets,
            |_, _| {
                forwarded = true;
                Ok(Value::Null)
            },
            crate::managed::ManagedRequest::Start {
                expected_origin: "https://fixture.invalid".into(),
                mode: Some("visual".into()),
            },
        )
        .is_err()
            && !forwarded;
        worker.shutdown();
        if !restart || !denied {
            return Err(AppError::new("Package restart/enrollment fixture failed"));
        }
        Ok(
            serde_json::json!({"fixture":true,"generation":"completed","bundledNode":true,"bundledHeadlessBrowser":true,"restartPreservedSite":restart,"unenrolledManagedDenied":denied,"gui":false,"credentials":"memory-only","platformAcceptance":false}),
        )
    })();
    if data.parent() == Some(parent.as_path())
        && data.file_name().is_some_and(|n| {
            n.to_string_lossy()
                .starts_with("site-factory-package-smoke-")
        })
    {
        let _ = std::fs::remove_dir_all(&data);
    }
    result
}
#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn missing_package_keeps_controller_alive_and_returns_a_recoverable_error() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let data = root.join(format!(
            ".local-state/missing-package-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = LaunchConfig {
            node: data.join("missing/node.exe"),
            script: data.join("missing/apps/worker/src/stdio.js"),
            source: data.join("missing"),
            data: data.clone(),
        };
        let mut worker = Worker::lazy(config)
            .expect("A missing packaged runtime must not prevent panel/controller construction");
        let error = worker
            .request(DesktopRequest {
                id: "missing".into(),
                version: 1,
                method: "device.status".into(),
                params: json!({}),
            })
            .unwrap_err();
        assert_eq!(error.code, "NEEDS_ATTENTION");
        assert!(error.message.contains("переустанов"));
        drop(worker);
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn private_settings_rotate_delete_and_reload_without_secret_in_public_results() {
        use std::sync::{Arc, Mutex};
        struct Memory(Arc<Mutex<Option<String>>>);
        impl SecretStore for Memory {
            fn put(&self, _: &str, value: &str) -> Result<(), AppError> {
                *self.0.lock().unwrap() = Some(value.into());
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
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let data = root.join(format!(
            ".local-state/secret-pipe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut worker = Worker::new(LaunchConfig {
            node: PathBuf::from(std::env::var_os("SITE_FACTORY_TEST_NODE").unwrap()),
            script: root.join("dist/apps/worker/src/stdio.js"),
            source: root,
            data: data.clone(),
        })
        .unwrap();
        let memory = Arc::new(Mutex::new(None));
        worker.secrets = Box::new(Memory(memory.clone()));
        for key in ["synthetic-first", "synthetic-rotated"] {
            let result = worker
                .settings(SettingsRequest::Save {
                    api_key: key.into(),
                    model: "explicit-model".into(),
                    image_model: None,
                })
                .unwrap();
            assert_eq!(result["mode"], "live");
            assert_eq!(result["images"], "disabled");
            assert!(!result.to_string().contains(key));
            assert!(!std::fs::read_to_string(data.join("model-settings.json"))
                .unwrap()
                .contains(key));
            assert_eq!(memory.lock().unwrap().as_deref(), Some(key));
        }
        worker.shutdown();
        assert_eq!(
            worker.settings(SettingsRequest::Status {}).unwrap()["mode"],
            "live"
        );
        assert!(worker
            .request(DesktopRequest {
                id: "forged".into(),
                version: 1,
                method: "model.configure".into(),
                params: json!({"mode":"demo"})
            })
            .is_err());
        worker.process.as_mut().unwrap().child.kill().unwrap();
        worker.process.as_mut().unwrap().child.wait().unwrap();
        assert!(worker.settings(SettingsRequest::Delete {}).is_err());
        assert!(matches!(
            SavedModel::read(&data.join("model-settings.json")).unwrap(),
            SavedModel::Blocked
        ));
        assert_eq!(
            worker.settings(SettingsRequest::Status {}).unwrap()["mode"],
            "blocked"
        );
        assert_eq!(
            worker.settings(SettingsRequest::Delete {}).unwrap()["mode"],
            "blocked"
        );
        assert!(memory.lock().unwrap().is_none());
        assert_eq!(
            worker.settings(SettingsRequest::Demo {}).unwrap()["mode"],
            "demo"
        );
        worker.shutdown();
        drop(worker);
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn starts_real_node_and_restarts_after_shutdown() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let data = root.join(".local-state/rust-worker-test");
        let node = std::env::var_os("SITE_FACTORY_TEST_NODE")
            .map(PathBuf::from)
            .expect("Set SITE_FACTORY_TEST_NODE to trusted Node executable");
        let config = LaunchConfig {
            node,
            script: root.join("dist/apps/worker/src/stdio.js"),
            source: root,
            data,
        };
        let mut worker = Worker::new(config.clone()).unwrap();
        assert!(
            Worker::new(config).is_err(),
            "A second controlling process must not acquire the state lock"
        );
        let request = || DesktopRequest {
            id: "native-test".into(),
            version: 1,
            method: "device.status".into(),
            params: json!({}),
        };
        assert_eq!(worker.request(request()).unwrap()["mode"], "demo");
        let pid = worker.process.as_ref().unwrap().child.id();
        worker.shutdown();
        assert!(worker.process.is_none());
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
            let process = OpenProcess(0x00100000, 0, pid);
            if !process.is_null() {
                assert_eq!(
                    WaitForSingleObject(process, 0),
                    0,
                    "Shutdown must reap Node, not merely detach its handle"
                );
                windows_sys::Win32::Foundation::CloseHandle(process);
            }
        }
        assert_eq!(worker.request(request()).unwrap()["available"], true);
        worker.process.as_mut().unwrap().child.kill().unwrap();
        worker.process.as_mut().unwrap().child.wait().unwrap();
        assert_eq!(worker.request(request()).unwrap()["available"], true);
        worker.shutdown();
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn managed_identity_uses_private_fixed_sidecar_pipe() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data = root.join(format!(".local-state/managed-pipe-{unique}"));
        let mut worker = Worker::new(LaunchConfig {
            node: PathBuf::from(std::env::var_os("SITE_FACTORY_TEST_NODE").unwrap()),
            script: root.join("dist/apps/worker/src/stdio.js"),
            source: root,
            data: data.clone(),
        })
        .unwrap();
        let request = || DesktopRequest {
            id: "native-managed".into(),
            version: 1,
            method: "managed.prepare".into(),
            params: json!({}),
        };
        assert!(
            worker.request(request()).is_err(),
            "Generic dispatch cannot mint credentials"
        );
        let first = worker.exchange(request()).unwrap();
        let second = worker.exchange(request()).unwrap();
        assert_eq!(first["workerId"].as_str().unwrap().len(), 36);
        assert_eq!(first["token"].as_str().unwrap().len(), 43);
        assert_ne!(first["workerId"], second["workerId"]);
        assert_ne!(first["token"], second["token"]);
        let status = worker
            .exchange(DesktopRequest {
                id: "native-managed".into(),
                version: 1,
                method: "managed.status".into(),
                params: json!({}),
            })
            .unwrap();
        assert_eq!(status, json!({"running":false,"error":null}));
        worker.shutdown();
        drop(worker);
        std::fs::remove_dir_all(data).unwrap();
    }

    fn run_failure_case(failure: &str) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data = root.join(format!(".local-state/transport-{failure}-{unique}"));
        std::fs::create_dir_all(&data).unwrap();
        let script = data.join("worker.cjs");
        std::fs::write(&script, r#"
const fs = require('node:fs');
const path = require('node:path');
const lines = require('node:readline').createInterface({input:process.stdin});
let tail=Promise.resolve();
lines.on('line', line => { tail=tail.then(async()=>{
 const request = JSON.parse(line);
 if(request.method==='model.configure'){process.stdout.write(JSON.stringify({id:request.id,result:{mode:request.params.mode}})+'\n');return;}
 fs.appendFileSync(path.join(process.env.SITE_FACTORY_DATA_ROOT,'requests.log'), request.id+'\n');
 const result = {id:request.id,result:{pid:process.pid}};
 switch(request.id){
  case 'late':await new Promise(resolve=>setTimeout(resolve,180));process.stdout.write(JSON.stringify(result)+'\n');break;
  case 'application-error':process.stdout.write(JSON.stringify({id:request.id,error:{code:'CONFLICT',message:'Busy'}})+'\n');break;
  case 'bad-json':process.stdout.write('{broken\n');break;
  case 'wrong-id':process.stdout.write(JSON.stringify({...result,id:'foreign'})+'\n');break;
  case 'missing-result':process.stdout.write(JSON.stringify({id:request.id})+'\n');break;
  case 'bad-error':process.stdout.write(JSON.stringify({id:request.id,error:{code:7}})+'\n');break;
  case 'both':process.stdout.write(JSON.stringify({...result,error:{code:'CONFLICT',message:'invalid envelope'}})+'\n');break;
  default:process.stdout.write(JSON.stringify(result)+'\n');
 }
});});
"#).unwrap();
        let mut worker = Worker::new(LaunchConfig {
            node: PathBuf::from(std::env::var_os("SITE_FACTORY_TEST_NODE").unwrap()),
            script,
            source: root,
            data: data.clone(),
        })
        .unwrap();
        let request = |id: &str| DesktopRequest {
            id: id.into(),
            version: 1,
            method: "device.status".into(),
            params: json!({}),
        };
        let old_pid = worker.request(request("ready")).unwrap()["pid"].clone();
        assert_eq!(
            worker
                .request(request("application-error"))
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        assert_eq!(
            worker.request(request("after-error")).unwrap()["pid"],
            old_pid,
            "A valid application error must not discard a synchronized session"
        );
        if failure == "late" {
            worker.response_timeout = Duration::from_millis(60);
        }
        assert!(worker.request(request(failure)).is_err());
        worker.response_timeout = Duration::from_secs(30);
        let recovered = worker
            .request(request("next"))
            .expect("The next request must use a fresh synchronized worker");
        assert_ne!(
            recovered["pid"], old_pid,
            "Failed transport must not execute another request in the ambiguous session"
        );
        worker.shutdown();
        assert_eq!(
            std::fs::read_to_string(data.join("requests.log")).unwrap(),
            format!("ready\napplication-error\nafter-error\n{failure}\nnext\n"),
            "Ambiguous operations must never be replayed"
        );
        drop(worker);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn late_reply_cannot_shift_subsequent_requests() {
        run_failure_case("late");
    }

    #[test]
    fn malformed_and_foreign_replies_invalidate_the_session() {
        for failure in [
            "bad-json",
            "wrong-id",
            "missing-result",
            "bad-error",
            "both",
        ] {
            run_failure_case(failure);
        }
    }
}

#[cfg(all(test, windows))]
mod windows_descendant_tests {
    use super::*;
    #[test]
    fn private_grant_follows_job_attachment_and_job_close_kills_detached_descendant() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let bootstrap = root.join("dist/apps/worker/src/bootstrap.js");
        let script = format!(
            r#"
const {{pathToFileURL}} = await import('node:url');
const {{waitForNativeStart}} = await import(pathToFileURL({}).href);
process.stdout.write('READY\n');
await waitForNativeStart(process.stdin,true);
const {{spawn}} = await import('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{detached:true,stdio:'ignore',windowsHide:true}});
process.stdout.write(child.pid+'\n');
setInterval(()=>{{}},1000);
"#,
            serde_json::to_string(bootstrap.to_str().unwrap().trim_start_matches(r"\\?\")).unwrap()
        );
        let mut child = Command::new(std::env::var_os("SITE_FACTORY_TEST_NODE").unwrap())
            .args(["--input-type=module", "-e", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line, "READY\n");
        let job = WindowsJob::attach(&child).unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"SF_NATIVE_START_V1\n")
            .unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        let descendant: u32 = line.trim().parse().unwrap();
        unsafe {
            let descendant_handle = OpenProcess(0x00100000, 0, descendant);
            assert!(!descendant_handle.is_null());
            assert_eq!(WaitForSingleObject(descendant_handle, 0), 0x102);
            drop(job);
            assert_eq!(
                WaitForSingleObject(descendant_handle, 5000),
                0,
                "The owned detached descendant must die with the Job"
            );
            windows_sys::Win32::Foundation::CloseHandle(descendant_handle);
        }
        // Windows Job termination may report exit code zero; successful reaping
        // and the descendant wait above are the lifecycle observations.
        child.wait().unwrap();
    }
}
