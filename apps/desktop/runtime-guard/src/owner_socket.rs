//! Private owner endpoint lifetime; profiles remain in the application data root.
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
};

const OWNER_ROOT: &str = "/private/tmp";
const SOCKET_LIMIT: usize = 100;

pub struct WorkerPaths {
    pub temp: PathBuf,
    pub socket: PathBuf,
    directory: Option<PathBuf>,
}
impl WorkerPaths {
    #[cfg(target_os = "macos")]
    pub fn create(data: &Path) -> io::Result<Self> {
        use std::io::Read;
        // Neither app-data nor ambient TMPDIR may select/lengthen the owner endpoint.
        Self::create_with(data, Path::new(OWNER_ROOT), || {
            let mut bytes = [0u8; 16];
            fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
            Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
        })
    }
    fn create_with(
        data: &Path,
        root: &Path,
        mut nonce: impl FnMut() -> io::Result<String>,
    ) -> io::Result<Self> {
        for _ in 0..16 {
            let name = nonce()?;
            if name.len() != 32 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid owner directory nonce",
                ));
            }
            let directory = root.join(format!("sf-guard-{name}"));
            let socket = directory.join("owner.sock");
            if socket.as_os_str().len() > SOCKET_LIMIT {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Owner socket path too long",
                ));
            }
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let mut builder = builder;
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&directory) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
                Ok(()) => {}
            }
            let paths = Self {
                temp: data.join("runtime-temp"),
                socket,
                directory: Some(directory),
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // Creation was already private; ensure owner access even with a restrictive umask.
                fs::set_permissions(
                    paths.directory.as_ref().unwrap(),
                    fs::Permissions::from_mode(0o700),
                )?;
            }
            return Ok(paths);
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Cannot exclusively create owner directory",
        ))
    }
    #[cfg(target_os = "macos")]
    pub fn bind(&self) -> io::Result<std::os::unix::net::UnixListener> {
        use std::os::unix::{fs::PermissionsExt, net::UnixListener};
        let listener = UnixListener::bind(&self.socket)?;
        fs::set_permissions(&self.socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }
    pub fn close(mut self) -> io::Result<()> {
        self.remove()
    }
    fn remove(&mut self) -> io::Result<()> {
        if let Some(directory) = self.directory.take() {
            match fs::remove_file(&self.socket) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
            // Never recurse or remove a directory we failed to create exclusively.
            fs::remove_dir(directory)?;
        }
        Ok(())
    }
}
impl Drop for WorkerPaths {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

/// Stop/join the authenticated listener on every return before unlinking its endpoint.
pub struct OwnerListener {
    stopping: Arc<AtomicBool>,
    force: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl OwnerListener {
    pub fn new(stopping: Arc<AtomicBool>, force: Arc<AtomicBool>, thread: JoinHandle<()>) -> Self {
        Self {
            stopping,
            force,
            thread: Some(thread),
        }
    }
    pub fn stop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.force.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for OwnerListener {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            #[cfg(target_os = "macos")]
            let root = PathBuf::from(OWNER_ROOT);
            #[cfg(not(target_os = "macos"))]
            let root = std::env::temp_dir();
            let path = root.join(format!(
                "sf-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn nonce() -> io::Result<String> {
        Ok("a".repeat(32))
    }
    #[test]
    fn long_app_data_keeps_profiles_but_uses_short_private_owner_socket() {
        let root = TestRoot::new();
        let data = root.0.join("a".repeat(100));
        fs::create_dir(&data).unwrap();
        assert!(data.as_os_str().len() > 100);
        let paths = WorkerPaths::create_with(&data, &root.0, nonce).unwrap();
        assert_eq!(paths.temp, data.join("runtime-temp"));
        fs::create_dir(&paths.temp).unwrap();
        assert!(paths.socket.as_os_str().len() <= 100);
        let directory = paths.socket.parent().unwrap().to_path_buf();
        assert_ne!(directory, data);
        fs::write(&paths.socket, b"owned endpoint").unwrap();
        paths.close().unwrap();
        assert!(!directory.exists());
        assert!(data.join("runtime-temp").is_dir());
    }
    #[test]
    fn typical_mac_package_smoke_root_does_not_select_socket_location() {
        let root = TestRoot::new();
        let data = Path::new("/private/var/folders/ab/012345678901234567890123456789/T")
            .join("site-factory-package-smoke-1793250000000000000");
        assert!(data.join(".guard-123456789abc.sock").as_os_str().len() > 100);
        let paths = WorkerPaths::create_with(&data, &root.0, nonce).unwrap();
        assert_eq!(paths.temp, data.join("runtime-temp"));
        assert!(paths.socket.starts_with(&root.0));
        assert!(paths.socket.as_os_str().len() <= 100);
        assert_eq!(OWNER_ROOT, "/private/tmp");
    }
    #[test]
    fn collisions_retry_without_adopting_or_cleaning_existing_entries() {
        let root = TestRoot::new();
        let first = root.0.join(format!("sf-guard-{}", "a".repeat(32)));
        fs::create_dir(&first).unwrap();
        fs::write(first.join("keep"), b"pre-existing").unwrap();
        let second = root.0.join(format!("sf-guard-{}", "b".repeat(32)));
        fs::write(&second, b"pre-existing file").unwrap();
        let mut names = ["a", "b", "c"].into_iter();
        let paths =
            WorkerPaths::create_with(&root.0, &root.0, || Ok(names.next().unwrap().repeat(32)))
                .unwrap();
        let owned = paths.socket.parent().unwrap().to_path_buf();
        drop(paths);
        assert!(!owned.exists());
        assert_eq!(fs::read(first.join("keep")).unwrap(), b"pre-existing");
        assert_eq!(fs::read(second).unwrap(), b"pre-existing file");
        assert!(WorkerPaths::create_with(&root.0, &root.0, nonce).is_err());
        assert_eq!(fs::read(first.join("keep")).unwrap(), b"pre-existing");
    }
    #[test]
    fn creation_and_entropy_failures_leave_no_owner_directory() {
        let root = TestRoot::new();
        assert!(WorkerPaths::create_with(&root.0, &root.0.join("missing"), nonce).is_err());
        assert!(
            WorkerPaths::create_with(&root.0, &root.0, || Err(io::Error::other(
                "entropy unavailable"
            )))
            .is_err()
        );
        assert!(WorkerPaths::create_with(&root.0, &root.0, || Ok("../escape".into())).is_err());
        assert!(WorkerPaths::create_with(&root.0, &root.0.join("x".repeat(100)), nonce).is_err());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
    #[test]
    fn early_return_cleans_unbound_endpoint_and_nonrecursive_cleanup_preserves_extra_files() {
        let root = TestRoot::new();
        let paths = WorkerPaths::create_with(&root.0, &root.0, nonce).unwrap();
        let directory = paths.socket.parent().unwrap().to_path_buf();
        drop(paths);
        assert!(!directory.exists());
        let paths = WorkerPaths::create_with(&root.0, &root.0, nonce).unwrap();
        fs::write(directory.join("unexpected"), b"keep").unwrap();
        assert!(paths.close().is_err());
        assert_eq!(fs::read(directory.join("unexpected")).unwrap(), b"keep");
    }
    #[test]
    fn listener_failure_stops_and_joins_before_owner_directory_cleanup() {
        let root = TestRoot::new();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut directory = None;
        let failure = (|| -> io::Result<()> {
            let paths = WorkerPaths::create_with(&root.0, &root.0, nonce)?;
            fs::write(&paths.socket, b"endpoint")?;
            directory = Some(paths.socket.parent().unwrap().to_path_buf());
            let stopping = Arc::new(AtomicBool::new(false));
            let force = Arc::new(AtomicBool::new(false));
            let (stop_thread, force_thread, socket) =
                (stopping.clone(), force.clone(), paths.socket.clone());
            let thread = std::thread::spawn(move || {
                while !force_thread.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
                sender
                    .send(stop_thread.load(Ordering::SeqCst) && socket.exists())
                    .unwrap();
            });
            let _listener = OwnerListener::new(stopping, force, thread);
            Err(io::Error::other("worker startup or forwarding failed"))
        })();
        assert!(failure.is_err());
        assert!(receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap());
        assert!(!directory.unwrap().exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_fixed_root_binds_private_socket_and_cleans_after_bind_failure() {
        use std::os::unix::fs::PermissionsExt;
        let data = Path::new("/private/var/folders/ab/012345678901234567890123456789/T")
            .join("site-factory-package-smoke-1793250000000000000");
        let paths = WorkerPaths::create(&data).unwrap();
        let directory = paths.socket.parent().unwrap().to_path_buf();
        assert_eq!(directory.parent().unwrap(), Path::new(OWNER_ROOT));
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        let listener = paths.bind().unwrap();
        assert_eq!(
            fs::metadata(&paths.socket).unwrap().permissions().mode() & 0o7777,
            0o600
        );
        assert!(paths.bind().is_err());
        drop(listener);
        paths.close().unwrap();
        assert!(!directory.exists());
        let paths = WorkerPaths::create(&data).unwrap();
        let directory = paths.socket.parent().unwrap().to_path_buf();
        fs::write(&paths.socket, b"bind collision").unwrap();
        assert!(paths.bind().is_err());
        drop(paths);
        assert!(!directory.exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_fixed_root_ignores_long_ambient_tmpdir() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "owner_socket::tests::mac_fixed_root_binds_private_socket_and_cleans_after_bind_failure", "--nocapture"])
            .env("TMPDIR", format!("/private/var/folders/ab/{}/T", "x".repeat(180)))
            .output()
            .unwrap();
        assert!(
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
