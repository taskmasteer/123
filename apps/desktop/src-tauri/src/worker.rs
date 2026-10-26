use crate::commands::{validate, AppError, DesktopRequest};
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
            script: runtime.join("worker/stdio.js"),
            source: runtime,
            data,
        };
        config.check()?;
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
            return Err(AppError::new("Trusted Node, worker script and resource paths must exist. Set SITE_FACTORY_DEV_CONFIG for development."));
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
    fn stop(&mut self) {
        self.input.take(); // EOF lets Node checkpoint active jobs and close Chromium.
        let deadline = Instant::now() + Duration::from_secs(15);
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
}
impl Worker {
    pub fn new(config: LaunchConfig) -> Result<Self, AppError> {
        config.check()?;
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
        };
        worker.start()?;
        Ok(worker)
    }
    fn start(&mut self) -> Result<(), AppError> {
        let mut command = Command::new(&self.config.node);
        command
            .arg(&self.config.script)
            .current_dir(&self.config.data)
            .env_clear()
            .env("SITE_FACTORY_DATA_ROOT", &self.config.data)
            .env("SITE_FACTORY_SOURCE_ROOT", &self.config.source)
            .env("NODE_ENV", "development")
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
            "PLAYWRIGHT_BROWSERS_PATH",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
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
        let input = child.stdin.take();
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
        Ok(())
    }
    pub fn request(&mut self, request: DesktopRequest) -> Result<Value, AppError> {
        validate(&request)?;
        if self
            .process
            .as_mut()
            .map(|p| p.child.try_wait().ok().flatten().is_some())
            .unwrap_or(true)
        {
            self.shutdown();
            self.start()?;
        }
        let bytes = serde_json::to_vec(&request).map_err(|_| AppError::new("Invalid request"))?;
        if bytes.len() > 64000 {
            return Err(AppError::new("Request too large"));
        }
        let process = self.process.as_mut().unwrap();
        let input = process
            .input
            .as_mut()
            .ok_or_else(|| AppError::new("Worker is stopping"))?;
        input.write_all(&bytes)?;
        input.write_all(b"\n")?;
        input.flush()?;
        let response=process.responses.recv_timeout(Duration::from_secs(30)).map_err(|_|AppError{code:"NEEDS_ATTENTION".into(),message:"Worker unavailable. Restart the application; the last operation may have been saved.".into()})?
    .map_err(AppError::new)?;
        if response["id"] != request.id {
            return Err(AppError::new("Mismatched worker response"));
        }
        if let Some(error) = response.get("error") {
            return Err(AppError {
                code: error["code"].as_str().unwrap_or("NEEDS_ATTENTION").into(),
                message: error["message"]
                    .as_str()
                    .unwrap_or("Worker request failed")
                    .into(),
            });
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| AppError::new("Malformed worker response"))
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
